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
  status: ContractRecord["status"];
  previewAvailable: boolean;
  executed: boolean;
  assignedVehicleAvailable: boolean;
  registrationNumber: string | null;
  registrationValidTo: string | null;
  insuranceValidTo: string | null;
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
    headOfficeLocation?: string;
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
}): ContractService {
  const environment = options.environment ?? "production";
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
          if (templateRow === null) {
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
      const payloadHash = hashPayload({
        contractId: input.contractId,
        expectedVersion: input.expectedVersion,
        applicantSignature: input.applicantSignature,
        guarantorSignature: input.guarantorSignature,
        staffWitnessId: input.staffWitnessId,
        executionDate: executionDate.toISOString(),
        headOfficeLocation: input.headOfficeLocation ?? "Somoco head office",
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
          headOfficeLocation: required(
            input.headOfficeLocation ?? "Somoco head office",
            "HEAD_OFFICE_LOCATION_REQUIRED",
          ),
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
            headOfficeLocation:
              input.headOfficeLocation ?? "Somoco head office",
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
        const coverage =
          assignment === null
            ? null
            : await repo.findCurrentInsuranceRegistration(
                assignment.vehicle_unit_id,
              );
        if (
          execution === null ||
          handover === null ||
          assignment === null ||
          offer === null ||
          offer.status !== "ACCEPTED" ||
          deposit === null ||
          coverage === null ||
          coverage.registration_valid_to === null ||
          coverage.insurance_valid_to === null ||
          !dateIsCurrent(coverage.registration_valid_to, now) ||
          !dateIsCurrent(coverage.insurance_valid_to, now)
        ) {
          throw new AppError(
            409,
            "ACTIVATION_GATES_INCOMPLETE",
            "Execution, reconciled deposit, assignment, checklist, registration, and insurance gates are required.",
          );
        }
        const vehicle = await repo.lockVehicle(assignment.vehicle_unit_id);
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
        const installments = extractInstallments(terms);
        await repo.insertRepaymentSchedule({
          contractId: contract.id,
          totalMinor: BigInt(offer.total_payable_minor_units ?? 0),
          firstDueDate:
            installments[0]?.dueDate ??
            new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10),
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
            firstDueDate: installments[0]?.dueDate ?? null,
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
      const vehicle = await repo.customerVehicleSummary(applicationId);
      const execution = await repo.latestExecution(contract.id);
      return {
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

function dateIsCurrent(value: string | Date, now: Date): boolean {
  const parsed =
    value instanceof Date ? value : new Date(`${value}T23:59:59.999Z`);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() >= now.getTime();
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

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
