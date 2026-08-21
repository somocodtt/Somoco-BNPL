import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  assetContractRepo,
  enqueueOutbox,
  withTransaction,
  type Database,
} from "@somo/db";
import type {
  CustomerPrincipal,
  StaffPrincipal,
} from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";
import type { AssetService } from "../assets/service.js";
import type { ContractRecord, ContractService } from "./service.js";

export interface HandoverConditionEvidence {
  description: string;
  checkResult: string;
}

export interface HandoverAccessoriesEvidence {
  items: readonly string[];
  none?: boolean;
}

export interface HandoverService {
  acknowledge(input: {
    contractId: string;
    checklistVersion: string;
    checklist: Record<string, unknown>;
    actor: CustomerPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<{
    id: string;
    contractId: string;
    checklistVersion: string;
    acknowledgedAt: string;
  }>;
  complete(input: {
    contractId: string;
    expectedVersion: number;
    checklistVersion: string;
    checklist: Record<string, unknown>;
    customerAcknowledged: boolean;
    customerAcknowledgementId: string;
    customerAcknowledgedByPersonId?: string;
    condition: HandoverConditionEvidence;
    accessories: HandoverAccessoriesEvidence;
    headOfficeId: string;
    headOfficeLocation: string;
    handedOverAt: string;
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<ContractRecord>;
}

export function createHandoverService(options: {
  database: Database;
  assets: AssetService;
  contracts: ContractService;
  headOffice?: { id: string; location: string };
}): HandoverService {
  void options.assets;
  const headOffice = options.headOffice;
  return {
    async acknowledge(input) {
      const checklistVersion = input.checklistVersion.trim();
      if (checklistVersion.length === 0)
        throw new AppError(
          400,
          "HANDOVER_CHECKLIST_VERSION_REQUIRED",
          "A versioned handover checklist is required.",
        );
      if (!isCompleteChecklist(input.checklist))
        throw new AppError(
          409,
          "HANDOVER_CHECKLIST_INCOMPLETE",
          "Every configured handover checklist item must be acknowledged.",
        );
      const payloadHash = hashPayload({
        contractId: input.contractId,
        checklistVersion,
        checklist: input.checklist,
      });
      const scope = `contract:${input.contractId}:handover-ack`;
      const existing = await assetContractRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (
          existing.payloadHash !== payloadHash ||
          existing.actorPersonId !== input.actor.personId
        )
          throw idempotencyConflict();
        return replayAcknowledgement(existing.response);
      }
      const now = new Date();
      return withTransaction(options.database, async (tx) => {
        const repo = assetContractRepo(tx);
        if (
          !(await repo.validCustomerSessionBinding({
            customerAccountId: input.actor.customerAccountId,
            customerSessionId: input.actor.sessionId,
            personId: input.actor.personId,
            now,
          }))
        )
          throw new AppError(
            403,
            "CUSTOMER_SESSION_INVALID",
            "The customer authentication session is not valid for this acknowledgement.",
          );
        const contract = await repo.lockContract(input.contractId);
        if (contract === null)
          throw new AppError(404, "CONTRACT_NOT_FOUND", "Contract not found.");
        const application = await repo.findApplication(
          contract.application_id,
          true,
        );
        if (
          application === null ||
          application.applicant_person_id !== input.actor.personId
        )
          throw new AppError(
            403,
            "FORBIDDEN",
            "Only the authenticated applicant may acknowledge handover.",
          );
        if (contract.status !== "EXECUTED")
          throw new AppError(
            409,
            "HANDOVER_EXECUTION_REQUIRED",
            "The contract must be physically executed before customer acknowledgement.",
          );
        const acknowledgement = await repo.insertHandoverAcknowledgement({
          id: randomUUID(),
          contractId: contract.id,
          applicationId: application.id,
          personId: input.actor.personId,
          customerAccountId: input.actor.customerAccountId,
          customerSessionId: input.actor.sessionId,
          checklistVersion,
          checklistHash: payloadHash,
          acknowledgedAt: now,
          idempotencyKey: input.idempotencyKey,
        });
        const response = {
          id: acknowledgement.id,
          contractId: acknowledgement.contract_id,
          checklistVersion: acknowledgement.checklist_version,
          acknowledgedAt: toDate(acknowledgement.acknowledged_at).toISOString(),
        };
        const command = await repo.insertCommand({
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: "HANDOVER_ACKNOWLEDGE",
          payloadHash,
          actorPersonId: input.actor.personId,
          applicationId: application.id,
          contractId: contract.id,
          response,
        });
        if (!command.inserted) {
          if (
            command.payloadHash !== payloadHash ||
            command.actorPersonId !== input.actor.personId
          )
            throw idempotencyConflict();
          return replayAcknowledgement(command.response);
        }
        await repo.updateCommandResponse(scope, input.idempotencyKey, response);
        await appendAuditEvent(tx, {
          aggregateType: "contract",
          aggregateId: contract.id,
          action: "CUSTOMER_HANDOVER_ACKNOWLEDGED",
          actorPersonId: input.actor.personId,
          requestId: input.requestId,
          data: {
            acknowledgementId: acknowledgement.id,
            checklistVersion,
            checklistHash: payloadHash,
          },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "contract.customer_handover_acknowledged",
          aggregateType: "contract",
          aggregateId: contract.id,
          payload: response,
          occurredAt: now,
        });
        return response;
      });
    },
    async complete(input) {
      if (!input.actor.roles.includes("INVENTORY_OFFICER"))
        throw new AppError(
          403,
          "FORBIDDEN",
          "This handover control is not permitted for the staff role.",
        );
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1
      )
        throw new AppError(
          400,
          "VERSION_INVALID",
          "The contract version is invalid.",
        );
      const checklistVersion = input.checklistVersion.trim();
      if (checklistVersion.length === 0)
        throw new AppError(
          400,
          "HANDOVER_CHECKLIST_VERSION_REQUIRED",
          "A versioned handover checklist is required.",
        );
      if (!isCompleteChecklist(input.checklist))
        throw new AppError(
          409,
          "HANDOVER_CHECKLIST_INCOMPLETE",
          "Every required handover checklist item must be acknowledged.",
        );
      if (!input.customerAcknowledged)
        throw new AppError(
          409,
          "CUSTOMER_ACKNOWLEDGEMENT_REQUIRED",
          "Customer acknowledgement is required at handover.",
        );
      if (
        typeof input.customerAcknowledgementId !== "string" ||
        input.customerAcknowledgementId.trim().length === 0
      )
        throw new AppError(
          409,
          "CUSTOMER_ACKNOWLEDGEMENT_REQUIRED",
          "An applicant-authenticated acknowledgement is required at handover.",
        );
      validateHandoverEvidence(input.condition, input.accessories);
      const handedOverAt = parseDate(
        input.handedOverAt,
        "HANDOVER_DATE_INVALID",
      );
      if (handedOverAt > new Date())
        throw new AppError(
          400,
          "HANDOVER_DATE_INVALID",
          "The handover date cannot be in the future.",
        );
      const configuredHeadOffice = requireConfiguredHeadOffice(
        headOffice,
        input.headOfficeId,
        input.headOfficeLocation,
      );
      const payloadHash = hashPayload({
        contractId: input.contractId,
        expectedVersion: input.expectedVersion,
        checklistVersion,
        checklist: input.checklist,
        customerAcknowledged: input.customerAcknowledged,
        customerAcknowledgedByPersonId:
          input.customerAcknowledgedByPersonId ?? null,
        condition: input.condition,
        accessories: input.accessories,
        headOfficeId: configuredHeadOffice.id,
        headOfficeLocation: configuredHeadOffice.location,
        customerAcknowledgementId: input.customerAcknowledgementId,
        handedOverAt: handedOverAt.toISOString(),
      });
      const scope = `contract:${input.contractId}:handover`;
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
          throw new AppError(404, "CONTRACT_NOT_FOUND", "Contract not found.");
        if (contract.version !== input.expectedVersion)
          throw new AppError(
            409,
            "STALE_VERSION",
            "The contract changed before handover.",
          );
        if (contract.status !== "EXECUTED")
          throw new AppError(
            409,
            "HANDOVER_EXECUTION_REQUIRED",
            "A physically executed contract is required before handover.",
          );
        const execution = await repo.latestExecution(contract.id);
        const assignment = await repo.currentAssignment(
          contract.application_id,
          true,
        );
        const application = await repo.findApplication(
          contract.application_id,
          true,
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
            "HANDOVER_GATES_INCOMPLETE",
            "Execution, reconciled deposit, assignment, registration, and insurance gates are required.",
          );
        }
        if (application === null)
          throw new AppError(
            404,
            "APPLICATION_NOT_FOUND",
            "Application not found.",
          );
        const acknowledgement = await repo.findHandoverAcknowledgement(
          input.customerAcknowledgementId,
          true,
        );
        const expectedChecklistHash = hashPayload({
          contractId: contract.id,
          checklistVersion,
          checklist: input.checklist,
        });
        if (
          acknowledgement === null ||
          acknowledgement.contract_id !== contract.id ||
          acknowledgement.application_id !== application.id ||
          acknowledgement.person_id !== application.applicant_person_id ||
          acknowledgement.checklist_version !== checklistVersion ||
          acknowledgement.checklist_hash !== expectedChecklistHash ||
          (input.customerAcknowledgedByPersonId !== undefined &&
            input.customerAcknowledgedByPersonId !== application.applicant_person_id)
        )
          throw new AppError(
            403,
            "CUSTOMER_ACKNOWLEDGEMENT_INVALID",
            "The applicant acknowledgement is missing or does not match this checklist.",
          );
        const customerPersonId = acknowledgement.person_id;
        const vehicle = await repo.lockVehicle(contract.vehicle_unit_id);
        if (vehicle === null)
          throw new AppError(
            404,
            "VEHICLE_NOT_FOUND",
            "The assigned vehicle was not found.",
          );
        if (vehicle.status !== "ASSIGNED" && vehicle.status !== "HANDED_OVER")
          throw new AppError(
            409,
            "HANDOVER_ASSIGNMENT_INVALID",
            "The vehicle is not in an assignable state.",
          );
        const existingHandover = await repo.findHandover(contract.id);
        if (existingHandover !== null)
          throw new AppError(
            409,
            "HANDOVER_ALREADY_COMPLETE",
            "Handover has already been recorded.",
          );
        await repo.insertHandover({
          id: randomUUID(),
          contractId: contract.id,
          checklist: input.checklist,
          checklistVersion,
          customerAcknowledgedAt: now,
          customerAcknowledgedByPersonId: customerPersonId,
          headOfficeId: configuredHeadOffice.id,
          condition: input.condition,
          accessories: input.accessories,
          headOfficeLocation: configuredHeadOffice.location,
          handedOverBy: input.actor.staffUserId,
          handedOverAt,
        });
        if (vehicle.status !== "HANDED_OVER")
          await repo.updateVehicleStatus(
            vehicle.id,
            vehicle.version,
            "HANDED_OVER",
            now,
          );
        const updated = await repo.updateContractStatus({
          id: contract.id,
          expectedVersion: input.expectedVersion,
          status: "EXECUTED",
          now,
        });
        const response = replayContract({
          ...serializeContract(updated),
        });
        const command = await repo.insertCommand({
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: "HANDOVER_COMPLETE",
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
          action: "VEHICLE_HANDOVER_COMPLETED",
          actorStaffUserId: input.actor.staffUserId,
          requestId: input.requestId,
          data: {
            vehicleUnitId: vehicle.id,
            checklistVersion,
            headOfficeId: configuredHeadOffice.id,
            headOfficeLocation: configuredHeadOffice.location,
            customerAcknowledged: true,
          },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "asset.vehicle.handed_over",
          aggregateType: "contract",
          aggregateId: contract.id,
          payload: response,
          occurredAt: now,
        });
        return response;
      });
    },
  };
}

export const REQUIRED_HANDOVER_ITEM_IDS = [
  "identity_verified",
  "keys_received",
  "condition_recorded",
  "accessories_recorded",
] as const;

function validateHandoverEvidence(
  condition: HandoverConditionEvidence,
  accessories: HandoverAccessoriesEvidence,
): void {
  if (
    typeof condition !== "object" ||
    condition === null ||
    typeof condition.description !== "string" ||
    condition.description.trim().length === 0 ||
    typeof condition.checkResult !== "string" ||
    condition.checkResult.trim().length === 0
  )
    throw new AppError(
      400,
      "HANDOVER_CONDITION_INVALID",
      "A nonempty condition description and check result are required.",
    );
  if (
    typeof accessories !== "object" ||
    accessories === null ||
    !Array.isArray(accessories.items) ||
    accessories.items.some(
      (item) => typeof item !== "string" || item.trim().length === 0,
    ) ||
    (accessories.items.length === 0 && accessories.none !== true) ||
    (accessories.items.length > 0 && accessories.none === true)
  )
    throw new AppError(
      400,
      "HANDOVER_ACCESSORIES_INVALID",
      "Accessories must explicitly list items or affirm that none were supplied.",
    );
}

function isCompleteChecklist(value: Record<string, unknown>): boolean {
  if (!Array.isArray(value.items) || value.items.length !== REQUIRED_HANDOVER_ITEM_IDS.length)
    return false;
  const seen = new Set<string>();
  for (const item of value.items) {
    if (typeof item !== "object" || item === null) return false;
    const row = item as Record<string, unknown>;
    if (
      typeof row.itemId !== "string" ||
      seen.has(row.itemId) ||
      !REQUIRED_HANDOVER_ITEM_IDS.includes(
        row.itemId as (typeof REQUIRED_HANDOVER_ITEM_IDS)[number],
      ) ||
      row.result !== "PASS"
    )
      return false;
    seen.add(row.itemId);
  }
  return seen.size === REQUIRED_HANDOVER_ITEM_IDS.length;
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

function dateAtUtcStart(value: string | Date): Date {
  return value instanceof Date
    ? value
    : /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00.000Z`)
      : new Date(value);
}

function requireConfiguredHeadOffice(
  configured: { id: string; location: string } | undefined,
  id: string,
  location: string,
): { id: string; location: string } {
  if (
    configured === undefined ||
    configured.id.trim().length === 0 ||
    configured.location.trim().length === 0 ||
    id.trim() !== configured.id ||
    location.trim() !== configured.location
  )
    throw new AppError(
      409,
      "HEAD_OFFICE_BINDING_INVALID",
      "Handover must occur at the configured main head office.",
    );
  return configured;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function idempotencyConflict(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
    "The idempotency key was reused for a different handover.",
  );
}

function replayAcknowledgement(value: Record<string, unknown>): {
  id: string;
  contractId: string;
  checklistVersion: string;
  acknowledgedAt: string;
} {
  if (
    typeof value.id !== "string" ||
    typeof value.contractId !== "string" ||
    typeof value.checklistVersion !== "string" ||
    typeof value.acknowledgedAt !== "string"
  )
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved acknowledgement command is invalid.",
    );
  return value as {
    id: string;
    contractId: string;
    checklistVersion: string;
    acknowledgedAt: string;
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function serializeContract(row: {
  id: string;
  reference: string;
  application_id: string;
  offer_version_id: string;
  vehicle_unit_id: string;
  status: string;
  version: number;
  canonical_hash: string | null;
  preview_reference: string | null;
  outstanding_balance_minor_units: bigint | string;
  generated_at: Date | string | null;
  activated_at: Date | string | null;
}): ContractRecord {
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
    generatedAt:
      row.generated_at instanceof Date
        ? row.generated_at.toISOString()
        : new Date(row.generated_at).toISOString(),
    activatedAt:
      row.activated_at === null
        ? null
        : row.activated_at instanceof Date
          ? row.activated_at.toISOString()
          : new Date(row.activated_at).toISOString(),
  };
}

function replayContract(value: Record<string, unknown>): ContractRecord {
  if (typeof value.id !== "string" || typeof value.status !== "string")
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved handover command is invalid.",
    );
  return value as unknown as ContractRecord;
}
