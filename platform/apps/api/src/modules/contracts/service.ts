import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  assetContractRepo,
  enqueueOutbox,
  withTransaction,
  type AssetContractRow,
  type Database,
} from "@somo/db";
import type { CustomerPrincipal, StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface ContractTemplateAttestation {
  templateVersionId?: string;
  templateKey: string;
  versionNumber: number;
  contentHash: string;
  approvedPdfHash: string;
  approvedBy?: string;
  effectiveFrom: string;
  effectiveUntil?: string;
}

const templateMode = new WeakMap<object, "PRODUCTION" | "TEST">();

/** Synthetic templates are intentionally branded test-only and are rejected in production. */
export function createSyntheticContractTemplateForTesting(): ContractTemplateAttestation {
  const template: ContractTemplateAttestation = {
    templateKey: "synthetic-task-10-template",
    versionNumber: 1,
    contentHash: createHash("sha256")
      .update("synthetic-task-10-content")
      .digest("hex"),
    approvedPdfHash: createHash("sha256")
      .update("synthetic-task-10-pdf")
      .digest("hex"),
    effectiveFrom: "2026-01-01T00:00:00.000Z",
  };
  templateMode.set(template, "TEST");
  return Object.freeze(template);
}

/** Runtime composition may inject an externally attested production template. */
export function createProductionContractTemplateAttestation(
  input: ContractTemplateAttestation,
): ContractTemplateAttestation {
  if (
    !isTemplateShape(input) ||
    typeof input.templateVersionId !== "string" ||
    !isUuid(input.templateVersionId) ||
    typeof input.approvedBy !== "string" ||
    input.approvedBy.trim().length === 0
  )
    throw new Error("LEGAL_TEMPLATE_ATTESTATION_INVALID");
  const template = Object.freeze({ ...input });
  templateMode.set(template, "PRODUCTION");
  return template;
}

export interface ContractRecord extends Record<string, unknown> {
  id: string;
  reference: string;
  applicationId: string;
  offerVersionId: string;
  vehicleUnitId: string;
  status:
    | "DRAFT"
    | "AWAITING_EXECUTION"
    | "EXECUTED"
    | "ACTIVE"
    | "SETTLED"
    | "RECOVERY"
    | "TERMINATED";
  version: number;
  canonicalHash: string;
  previewReference: string;
  ownershipHolder: "SOMOCO";
  outstandingBalanceMinor: string;
  generatedAt: string;
  activatedAt: string | null;
}

export interface CustomerContractView {
  contractId: string;
  status: ContractRecord["status"];
  previewAvailable: boolean;
  executed: boolean;
  assignedVehicleAvailable: boolean;
  registrationNumber: string | null;
  registrationValidTo: string | null;
  insuranceValidTo: string | null;
  handoverAcknowledged: boolean;
  schedule: readonly {
    sequence: number;
    dueDate: string;
    totalMinor: string;
  }[];
}

export interface ContractService {
  generate(input: {
    applicationId: string;
    assignmentId: string;
    templateVersionId?: string;
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<ContractRecord>;
  recordPhysicalExecution(input: {
    contractId: string;
    expectedVersion: number;
    applicantSignature: string;
    guarantorSignature: string;
    staffWitnessId: string;
    executionDate: string;
    headOfficeId: string;
    headOfficeLocation: string;
    executedDocumentId: string;
    executedDocumentHash: string;
    authorizationReason?: string;
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<ContractRecord>;
  activate(input: {
    contractId: string;
    expectedVersion: number;
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<ContractRecord>;
  getForCustomer(
    applicationId: string,
    actor: CustomerPrincipal,
  ): Promise<CustomerContractView | null>;
  get(applicationId: string): Promise<ContractRecord | null>;
}

export function createContractService(options: {
  database: Database;
  template?: ContractTemplateAttestation;
  environment?: "test" | "production";
  headOffice?: { id: string; location: string };
}): ContractService {
  const environment = options.environment ?? "production";
  const headOffice =
    options.headOffice ??
    (environment === "test"
      ? { id: "TEST_MAIN_HEAD_OFFICE", location: "TEST_MAIN_HEAD_OFFICE" }
      : undefined);
  if (options.template !== undefined && !isTrustedTemplate(options.template)) {
    throw new Error("LEGAL_TEMPLATE_ATTESTATION_INVALID");
  }
  return {
    async generate(input) {
      requireInventoryRole(input.actor);
      const template = options.template;
      if (
        template === undefined ||
        !isTrustedTemplate(template) ||
        (environment === "production" &&
          templateMode.get(template) !== "PRODUCTION") ||
        (environment !== "production" &&
          templateMode.get(template) !== "TEST" &&
          templateMode.get(template) !== "PRODUCTION")
      ) {
        throw new AppError(
          403,
          "LEGAL_TEMPLATE_APPROVAL_REQUIRED",
          "An externally attested approved legal template is required.",
        );
      }
      const payloadHash = hashPayload({
        applicationId: input.applicationId,
        assignmentId: input.assignmentId,
        templateVersionId: input.templateVersionId ?? null,
        templateKey: template.templateKey,
        templateVersion: template.versionNumber,
      });
      const scope = `application:${input.applicationId}:contract-generate`;
      const existing = await assetContractRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (
          existing.payloadHash !== payloadHash ||
          existing.actorStaffUserId !== input.actor.staffUserId
        )
          throw idempotencyConflict();
        return replayContract(existing.response);
      }
      const now = new Date();
      const effectiveFrom = parseDate(
        template.effectiveFrom,
        "LEGAL_TEMPLATE_WINDOW_INVALID",
      );
      const effectiveUntil =
        template.effectiveUntil === undefined
          ? undefined
          : parseDate(template.effectiveUntil, "LEGAL_TEMPLATE_WINDOW_INVALID");
      if (
        effectiveFrom > now ||
        (effectiveUntil !== undefined && effectiveUntil <= now)
      ) {
        throw new AppError(
          409,
          "LEGAL_TEMPLATE_NOT_EFFECTIVE",
          "The legal template is not effective.",
        );
      }
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const application = await repo.findApplication(
            input.applicationId,
            true,
          );
          if (application === null)
            throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
          if (
            application.status !== "APPROVED" &&
            application.status !== "AWAITING_EXECUTION"
          ) {
            throw new AppError(
              409,
              "MD_APPROVAL_REQUIRED",
              "The application is not approved for contract generation.",
            );
          }
          const guarantorPersonId =
            application.guarantor_person_id ??
            (await repo.confirmedGuarantor(application.id));
          if (guarantorPersonId === null)
            throw new AppError(
              409,
              "GUARANTOR_EVIDENCE_REQUIRED",
              "A confirmed guarantor is required before contract generation.",
            );
          const assignment = await repo.findAssignment(input.assignmentId);
          if (
            assignment === null ||
            assignment.application_id !== input.applicationId ||
            assignment.released_at !== null ||
            assignment.offer_version_id === null
          ) {
            throw new AppError(
              409,
              "ACTIVE_ASSIGNMENT_REQUIRED",
              "A current vehicle assignment is required.",
            );
          }
          const offer = await repo.lockOfferByApplication(input.applicationId);
          if (
            offer === null ||
            offer.status !== "ACCEPTED" ||
            offer.accepted_version_id === null ||
            offer.offer_version_id === null ||
            offer.offer_version_id !== assignment.offer_version_id ||
            offer.expires_at === null ||
            new Date(offer.expires_at).getTime() <= now.getTime()
          ) {
            throw new AppError(
              409,
              "ACCEPTED_LOCKED_OFFER_REQUIRED",
              "The accepted locked offer is not available.",
            );
          }
          let templateRow =
            input.templateVersionId === undefined
              ? null
              : await repo.findTemplate(input.templateVersionId, now);
          if (environment === "production") {
            if (
              template.templateVersionId === undefined ||
              input.templateVersionId !== template.templateVersionId ||
              templateRow === null ||
              templateRow.attestation_mode !== "PRODUCTION" ||
              templateRow.id !== template.templateVersionId ||
              templateRow.template_key !== template.templateKey ||
              templateRow.version_number !== template.versionNumber ||
              templateRow.content_hash !== template.contentHash ||
              templateRow.approved_pdf_hash !== template.approvedPdfHash ||
              templateRow.approved_by !== template.approvedBy ||
              !sameInstant(templateRow.effective_from, effectiveFrom) ||
              !sameOptionalInstant(templateRow.effective_until, effectiveUntil)
            ) {
              throw new AppError(
                403,
                "LEGAL_TEMPLATE_APPROVAL_REQUIRED",
                "The exact attested production legal template is required.",
              );
            }
          } else if (templateRow === null) {
            const templateId = input.templateVersionId ?? randomUUID();
            templateRow = await repo.insertTemplate({
              id: templateId,
              templateKey: template.templateKey,
              versionNumber: template.versionNumber,
              contentHash: template.contentHash,
              approvedPdfHash: template.approvedPdfHash,
              approvedBy: template.approvedBy ?? input.actor.staffUserId,
              approvedAt: now,
              effectiveFrom,
              ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
              attestationMode: templateMode.get(template) ?? "TEST",
            });
          }
          if (templateRow === null)
            throw new AppError(
              403,
              "LEGAL_TEMPLATE_APPROVAL_REQUIRED",
              "The exact attested legal template is required.",
            );
          const canonicalHash = hashPayload({
            applicationId: input.applicationId,
            applicantPersonId: application.applicant_person_id,
            guarantorPersonId,
            offerVersionId: offer.offer_version_id,
            offerCanonicalHash: offer.canonical_hash,
            assignmentId: assignment.id,
            vehicleUnitId: assignment.vehicle_unit_id,
            templateId: templateRow.id,
            templateContentHash: templateRow.content_hash,
            templatePdfHash: templateRow.approved_pdf_hash,
          });
          const contract = await repo.insertContract({
            id: randomUUID(),
            reference: `SOMOCO-${input.applicationId.slice(0, 8).toUpperCase()}`,
            applicationId: input.applicationId,
            offerVersionId: offer.offer_version_id,
            templateVersionId: templateRow.id,
            vehicleUnitId: assignment.vehicle_unit_id,
            canonicalHash,
            previewReference: `contract-preview/${input.applicationId}/${canonicalHash}`,
            outstandingBalanceMinor: BigInt(offer.principal_minor_units ?? 0),
            generatedAt: now,
          });
          const response = serializeContract(contract);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "CONTRACT_GENERATE",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            applicationId: input.applicationId,
            contractId: contract.id,
            response,
          });
          if (!command.inserted) {
            if (
              command.payloadHash !== payloadHash ||
              command.actorStaffUserId !== input.actor.staffUserId
            )
              throw idempotencyConflict();
            return replayContract(command.response);
          }
          await repo.updateCommandResponse(
            scope,
            input.idempotencyKey,
            response,
          );
          await appendAuditEvent(tx, {
            aggregateType: "contract",
            aggregateId: contract.id,
            action: "CONTRACT_GENERATED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              applicationId: input.applicationId,
              templateVersionId: templateRow.id,
              canonicalHash,
            },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "contract.generated",
            aggregateType: "contract",
            aggregateId: contract.id,
            payload: response,
            occurredAt: now,
          });
          return response;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "CONTRACT_ALREADY_EXISTS",
            "A contract already exists for this application.",
          );
        throw error;
      }
    },

    async recordPhysicalExecution(input) {
      requireInventoryRole(input.actor);
      if (input.staffWitnessId !== input.actor.staffUserId)
        throw new AppError(
          403,
          "STAFF_WITNESS_REQUIRED",
          "The authenticated staff witness must record the execution.",
        );
      if (
        input.applicantSignature.trim().length === 0 ||
        input.guarantorSignature.trim().length === 0
      )
        throw new AppError(
          400,
          "SIGNATURES_REQUIRED",
          "Applicant and guarantor signatures are required.",
        );
      const executionDate = parseDate(
        input.executionDate,
        "EXECUTION_DATE_INVALID",
      );
      if (executionDate > new Date())
        throw new AppError(
          400,
          "EXECUTION_DATE_INVALID",
          "The execution date cannot be in the future.",
        );
      const hash = input.executedDocumentHash.trim();
      if (!/^[0-9a-f]{64}$/.test(hash))
        throw new AppError(
          400,
          "EXECUTED_DOCUMENT_HASH_INVALID",
          "The executed document hash is invalid.",
        );
      const executionHeadOffice = requireConfiguredHeadOffice(
        headOffice,
        input.headOfficeId,
        input.headOfficeLocation,
      );
      const payloadHash = hashPayload({
        contractId: input.contractId,
        expectedVersion: input.expectedVersion,
        applicantSignature: input.applicantSignature,
        guarantorSignature: input.guarantorSignature,
        staffWitnessId: input.staffWitnessId,
        executionDate: executionDate.toISOString(),
        headOfficeId: executionHeadOffice.id,
        headOfficeLocation: executionHeadOffice.location,
        executedDocumentId: input.executedDocumentId,
        executedDocumentHash: hash,
        authorizationReason: input.authorizationReason ?? null,
      });
      const scope = `contract:${input.contractId}:execute`;
      const existing = await assetContractRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (
          existing.payloadHash !== payloadHash ||
          existing.actorStaffUserId !== input.actor.staffUserId
        )
          throw idempotencyConflict();
        return replayContract(existing.response);
      }
      const now = new Date();
      return withTransaction(options.database, async (tx) => {
        const repo = assetContractRepo(tx);
        const contract = await repo.lockContract(input.contractId);
        if (contract === null)
          throw notFound("CONTRACT_NOT_FOUND", "Contract not found.");
        if (contract.version !== input.expectedVersion)
          throw new AppError(
            409,
            "STALE_VERSION",
            "The contract changed before physical execution.",
          );
        if (
          contract.status !== "AWAITING_EXECUTION" &&
          !(
            contract.status === "EXECUTED" &&
            input.authorizationReason !== undefined
          )
        ) {
          throw new AppError(
            409,
            "EXECUTION_STATE_INVALID",
            "The contract is not ready for physical execution.",
          );
        }
        const application = await repo.findApplication(contract.application_id);
        if (application === null)
          throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
        const document = await repo.cleanDocument(
          input.executedDocumentId,
          hash,
        );
        if (
          document === null ||
          document.person_id !== application.applicant_person_id
        )
          throw new AppError(
            409,
            "EXECUTED_DOCUMENT_NOT_CLEAN",
            "The executed PDF must be accepted, malware-scanned, and hash-matched.",
          );
        const previous = await repo.latestExecution(contract.id);
        const execution = await repo.insertExecution({
          id: randomUUID(),
          contractId: contract.id,
          versionNumber: (previous?.version_number ?? 0) + 1,
          applicantSignature: input.applicantSignature.trim(),
          guarantorSignature: input.guarantorSignature.trim(),
          staffWitnessId: input.staffWitnessId,
          executionDate,
          headOfficeId: executionHeadOffice.id,
          headOfficeLocation: executionHeadOffice.location,
          executedDocumentId: input.executedDocumentId,
          executedDocumentHash: hash,
          ...(input.authorizationReason === undefined
            ? {}
            : {
                authorizationReason: required(
                  input.authorizationReason,
                  "EXECUTION_CORRECTION_REASON_REQUIRED",
                ),
              }),
        });
        const updated = await repo.updateContractStatus({
          id: contract.id,
          expectedVersion: input.expectedVersion,
          status: "EXECUTED",
          now,
        });
        const response = serializeContract(updated);
        const command = await repo.insertCommand({
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: "CONTRACT_EXECUTE",
          payloadHash,
          actorStaffUserId: input.actor.staffUserId,
          contractId: contract.id,
          applicationId: contract.application_id,
          response,
        });
        if (!command.inserted) {
          if (
            command.payloadHash !== payloadHash ||
            command.actorStaffUserId !== input.actor.staffUserId
          )
            throw idempotencyConflict();
          return replayContract(command.response);
        }
        await repo.updateCommandResponse(scope, input.idempotencyKey, response);
        await appendAuditEvent(tx, {
          aggregateType: "contract",
          aggregateId: contract.id,
          action:
            input.authorizationReason === undefined
              ? "CONTRACT_PHYSICALLY_EXECUTED"
              : "CONTRACT_EXECUTION_CORRECTED",
          actorStaffUserId: input.actor.staffUserId,
          requestId: input.requestId,
          data: {
            executionId: execution.id,
            executedDocumentId: input.executedDocumentId,
            executedDocumentHash: hash,
            headOfficeId: executionHeadOffice.id,
            headOfficeLocation: executionHeadOffice.location,
          },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "contract.physically_executed",
          aggregateType: "contract",
          aggregateId: contract.id,
          payload: response,
          occurredAt: now,
        });
        return response;
      });
    },

    async activate(input) {
      requireInventoryRole(input.actor);
      const payloadHash = hashPayload({
        contractId: input.contractId,
        expectedVersion: input.expectedVersion,
      });
      const scope = `contract:${input.contractId}:activate`;
      const existing = await assetContractRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (
          existing.payloadHash !== payloadHash ||
          existing.actorStaffUserId !== input.actor.staffUserId
        )
          throw idempotencyConflict();
        return replayContract(existing.response);
      }
      const now = new Date();
      return withTransaction(options.database, async (tx) => {
        const repo = assetContractRepo(tx);
        const contract = await repo.lockContract(input.contractId);
        if (contract === null)
          throw notFound("CONTRACT_NOT_FOUND", "Contract not found.");
        if (contract.version !== input.expectedVersion) {
          if (contract.status === "ACTIVE") return serializeContract(contract);
          throw new AppError(
            409,
            "STALE_VERSION",
            "The contract changed before activation.",
          );
        }
        if (contract.status !== "EXECUTED")
          throw new AppError(
            409,
            "ACTIVATION_GATES_INCOMPLETE",
            "Physical execution and handover are required before activation.",
          );
        const execution = await repo.latestExecution(contract.id);
        const handover = await repo.findHandover(contract.id);
        const assignment = await repo.currentAssignment(
          contract.application_id,
        );
        const offer = await repo.lockOfferByApplication(
          contract.application_id,
        );
        const deposit =
          offer === null
            ? null
            : await repo.findDeposit(contract.application_id, offer.id);
        const coverage = await repo.findCurrentInsuranceRegistration(
          contract.vehicle_unit_id,
        );
        if (
          execution === null ||
          handover === null ||
          assignment === null ||
          assignment.vehicle_unit_id !== contract.vehicle_unit_id ||
          offer === null ||
          offer.status !== "ACCEPTED" ||
          deposit === null ||
          coverage === null ||
          coverage.registration_valid_to === null ||
          coverage.insurance_valid_to === null ||
          !coverageIsCurrent(
            coverage.registration_valid_from,
            coverage.registration_valid_to,
            now,
          ) ||
          !coverageIsCurrent(
            coverage.insurance_valid_from,
            coverage.insurance_valid_to,
            now,
          )
        ) {
          throw new AppError(
            409,
            "ACTIVATION_GATES_INCOMPLETE",
            "Execution, reconciled deposit, assignment, checklist, registration, and insurance gates are required.",
          );
        }
        const vehicle = await repo.lockVehicle(contract.vehicle_unit_id);
        if (vehicle === null || vehicle.status !== "HANDED_OVER")
          throw new AppError(
            409,
            "ACTIVATION_GATES_INCOMPLETE",
            "The assigned vehicle has not completed handover.",
          );
        const updated = await repo.updateContractStatus({
          id: contract.id,
          expectedVersion: input.expectedVersion,
          status: "ACTIVE",
          activatedAt: now,
          now,
        });
        const application = await repo.findApplication(
          contract.application_id,
          true,
        );
        if (application !== null && application.status !== "ACTIVE")
          await repo.updateApplicationStatus({
            id: application.id,
            expectedVersion: application.version,
            status: "ACTIVE",
            now,
          });
        const terms = offer.terms;
        const installments = parseLockedSchedule(
          terms,
          BigInt(offer.total_payable_minor_units ?? 0),
          now,
        );
        const firstInstallment = installments[0]!;
        await repo.insertRepaymentSchedule({
          contractId: contract.id,
          totalMinor: BigInt(offer.total_payable_minor_units ?? 0),
          firstDueDate: firstInstallment.dueDate,
          installments: installments.map((item) => ({
            ...item,
            totalMinor: BigInt(item.totalMinor),
          })),
        });
        const response = serializeContract(updated);
        const command = await repo.insertCommand({
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: "CONTRACT_ACTIVATE",
          payloadHash,
          actorStaffUserId: input.actor.staffUserId,
          contractId: contract.id,
          applicationId: contract.application_id,
          response,
        });
        if (!command.inserted) {
          if (
            command.payloadHash !== payloadHash ||
            command.actorStaffUserId !== input.actor.staffUserId
          )
            throw idempotencyConflict();
          return replayContract(command.response);
        }
        await repo.updateCommandResponse(scope, input.idempotencyKey, response);
        await appendAuditEvent(tx, {
          aggregateType: "contract",
          aggregateId: contract.id,
          action: "CONTRACT_ACTIVATED",
          actorStaffUserId: input.actor.staffUserId,
          requestId: input.requestId,
          data: {
            ownershipHolder: "SOMOCO",
            firstDueDate: firstInstallment.dueDate,
          },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "contract.activated",
          aggregateType: "contract",
          aggregateId: contract.id,
          payload: response,
          occurredAt: now,
        });
        return response;
      });
    },

    async getForCustomer(applicationId, actor) {
      const repo = assetContractRepo(options.database);
      const application = await repo.findApplication(applicationId);
      if (
        application === null ||
        application.applicant_person_id !== actor.personId
      )
        throw new AppError(
          403,
          "FORBIDDEN",
          "This contract does not belong to the customer.",
        );
      const contract = await repo.findContractByApplication(applicationId);
      if (contract === null) return null;
      const offer = await repo.lockOfferByApplication(applicationId);
      const terms = offer?.terms;
      const vehicle = await repo.customerVehicleSummary(
        applicationId,
        contract.vehicle_unit_id,
      );
      const execution = await repo.latestExecution(contract.id);
      const acknowledgement = await repo.findLatestHandoverAcknowledgement(
        contract.id,
      );
      return {
        contractId: contract.id,
        status: contract.status as ContractRecord["status"],
        previewAvailable:
          contract.status === "AWAITING_EXECUTION" ||
          contract.status === "EXECUTED" ||
          contract.status === "ACTIVE",
        executed: execution !== null,
        assignedVehicleAvailable: vehicle?.handed_over === true,
        registrationNumber:
          vehicle?.handed_over === true ? vehicle.registration_number : null,
        registrationValidTo:
          vehicle?.handed_over === true ? vehicle.registration_valid_to : null,
        insuranceValidTo:
          vehicle?.handed_over === true ? vehicle.insurance_valid_to : null,
        handoverAcknowledged: acknowledgement !== null,
        schedule: extractInstallments(terms),
      };
    },

    async get(applicationId) {
      const contract = await assetContractRepo(
        options.database,
      ).findContractByApplication(applicationId);
      return contract === null ? null : serializeContract(contract);
    },
  };
}

export function isTrustedTemplate(
  template: ContractTemplateAttestation,
): boolean {
  return (
    typeof template === "object" &&
    template !== null &&
    templateMode.has(template)
  );
}

function requireInventoryRole(actor: StaffPrincipal): void {
  if (!actor.roles.includes("INVENTORY_OFFICER"))
    throw new AppError(
      403,
      "FORBIDDEN",
      "This contract control is not permitted for the staff role.",
    );
}

function serializeContract(row: AssetContractRow): ContractRecord {
  if (
    row.canonical_hash === null ||
    row.preview_reference === null ||
    row.generated_at === null
  )
    throw new AppError(
      409,
      "CONTRACT_RECORD_INCOMPLETE",
      "The contract record is incomplete.",
    );
  return {
    id: row.id,
    reference: row.reference,
    applicationId: row.application_id,
    offerVersionId: row.offer_version_id,
    vehicleUnitId: row.vehicle_unit_id,
    status: row.status as ContractRecord["status"],
    version: row.version,
    canonicalHash: row.canonical_hash,
    previewReference: row.preview_reference,
    ownershipHolder: "SOMOCO",
    outstandingBalanceMinor: BigInt(
      row.outstanding_balance_minor_units,
    ).toString(),
    generatedAt: toDate(row.generated_at).toISOString(),
    activatedAt:
      row.activated_at === null ? null : toDate(row.activated_at).toISOString(),
  };
}

function replayContract(value: Record<string, unknown>): ContractRecord {
  if (
    typeof value.id !== "string" ||
    typeof value.applicationId !== "string" ||
    typeof value.status !== "string"
  )
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved contract command is invalid.",
    );
  return value as unknown as ContractRecord;
}

function parseDate(value: string, code: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(parsed.getTime()))
    throw new AppError(400, code, "The date is invalid.");
  return parsed;
}

function coverageIsCurrent(
  validFrom: string | Date | null,
  validUntil: string | Date | null,
  now: Date,
): boolean {
  if (validFrom === null || validUntil === null) return false;
  const from = dateAtUtcStart(validFrom);
  const until = dateAtUtcStart(validUntil);
  return (
    Number.isFinite(from.getTime()) &&
    Number.isFinite(until.getTime()) &&
    from.getTime() <= now.getTime() &&
    now.getTime() < until.getTime()
  );
}

function required(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0)
    throw new AppError(400, code, "A required value is missing.");
  return normalized;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function extractInstallments(
  value: Record<string, unknown> | null | undefined,
): { sequence: number; dueDate: string; totalMinor: string }[] {
  if (
    value === null ||
    value === undefined ||
    !Array.isArray(value.installments)
  )
    return [];
  return value.installments.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.sequence) ||
      typeof row.dueDate !== "string" ||
      typeof row.totalMinor !== "string" ||
      !/^\d+$/.test(row.totalMinor)
    )
      return [];
    return [
      {
        sequence: row.sequence as number,
        dueDate: row.dueDate,
        totalMinor: row.totalMinor,
      },
    ];
  });
}

function parseLockedSchedule(
  value: Record<string, unknown> | null | undefined,
  lockedTotalMinor: bigint,
  now: Date,
): { sequence: number; dueDate: string; totalMinor: string }[] {
  if (value === null || value === undefined || !Array.isArray(value.installments))
    throw new AppError(
      409,
      "LOCKED_SCHEDULE_INVALID",
      "The accepted offer does not contain a locked repayment schedule.",
    );
  const rows = value.installments;
  if (rows.length === 0)
    throw new AppError(
      409,
      "LOCKED_SCHEDULE_INVALID",
      "The accepted offer schedule cannot be empty.",
    );
  const parsed: { sequence: number; dueDate: string; totalMinor: string }[] = [];
  let sum = 0n;
  for (let index = 0; index < rows.length; index += 1) {
    const item = rows[index];
    if (typeof item !== "object" || item === null) invalidSchedule();
    const row = item as Record<string, unknown>;
    if (
      !Number.isSafeInteger(row.sequence) ||
      row.sequence !== index + 1 ||
      typeof row.dueDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(row.dueDate) ||
      !isValidDateOnly(row.dueDate) ||
      typeof row.totalMinor !== "string" ||
      !/^\d+$/.test(row.totalMinor) ||
      BigInt(row.totalMinor) <= 0n
    )
      invalidSchedule();
    const due = dateAtUtcStart(row.dueDate);
    if (due.getTime() < dateAtUtcStart(now).getTime()) invalidSchedule();
    const totalMinor = row.totalMinor as string;
    sum += BigInt(totalMinor);
    parsed.push({
      sequence: row.sequence as number,
      dueDate: row.dueDate,
      totalMinor,
    });
  }
  if (sum !== lockedTotalMinor) invalidSchedule();
  return parsed;
}

function invalidSchedule(): never {
  throw new AppError(
    409,
    "LOCKED_SCHEDULE_INVALID",
    "The accepted offer schedule must contain exact ordered dates and amounts whose sum equals the locked payable total.",
  );
}

function isValidDateOnly(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

function dateAtUtcStart(value: string | Date): Date {
  if (value instanceof Date) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T00:00:00.000Z`)
    : new Date(value);
}

function requireConfiguredHeadOffice(
  configured: { id: string; location: string } | undefined,
  id: string,
  location: string,
): { id: string; location: string } {
  if (configured === undefined)
    throw new AppError(
      503,
      "HEAD_OFFICE_CONFIGURATION_REQUIRED",
      "The configured main head-office binding is unavailable.",
    );
  if (
    id.trim() !== configured.id ||
    location.trim() !== configured.location ||
    configured.id.trim().length === 0 ||
    configured.location.trim().length === 0
  )
    throw new AppError(
      409,
      "HEAD_OFFICE_BINDING_INVALID",
      "Execution must occur at the configured main head office.",
    );
  return { id: configured.id, location: configured.location };
}

function sameInstant(value: Date | string, expected: Date): boolean {
  return toDate(value).getTime() === expected.getTime();
}

function sameOptionalInstant(
  value: Date | string | null,
  expected: Date | undefined,
): boolean {
  if (value === null || expected === undefined) return value === null && expected === undefined;
  return toDate(value).getTime() === expected.getTime();
}

function notFound(code: string, detail: string): AppError {
  return new AppError(404, code, detail);
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function idempotencyConflict(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
    "The idempotency key was reused with a different command.",
  );
}

function isTemplateShape(value: unknown): value is ContractTemplateAttestation {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.templateKey === "string" &&
    Number.isSafeInteger(row.versionNumber) &&
    typeof row.contentHash === "string" &&
    /^[0-9a-f]{64}$/.test(row.contentHash) &&
    typeof row.approvedPdfHash === "string" &&
    /^[0-9a-f]{64}$/.test(row.approvedPdfHash) &&
    typeof row.effectiveFrom === "string"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
