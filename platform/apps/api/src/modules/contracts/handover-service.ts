import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  assetContractRepo,
  enqueueOutbox,
  withTransaction,
  type Database,
} from "@somo/db";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";
import type { AssetService } from "../assets/service.js";
import type { ContractRecord, ContractService } from "./service.js";

export interface HandoverService {
  complete(input: {
    contractId: string;
    expectedVersion: number;
    checklistVersion: string;
    checklist: Record<string, unknown>;
    customerAcknowledged: boolean;
    customerAcknowledgedByPersonId?: string;
    condition: Record<string, unknown>;
    accessories: readonly string[];
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
}): HandoverService {
  void options.assets;
  return {
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
      const location = input.headOfficeLocation.trim();
      if (location.length === 0)
        throw new AppError(
          400,
          "HEAD_OFFICE_LOCATION_REQUIRED",
          "The physical head-office location is required.",
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
        headOfficeLocation: location,
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
        const coverage =
          assignment === null
            ? null
            : await repo.findCurrentInsuranceRegistration(
                assignment.vehicle_unit_id,
              );
        if (
          execution === null ||
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
        const customerPersonId =
          input.customerAcknowledgedByPersonId ??
          application.applicant_person_id;
        if (customerPersonId !== application.applicant_person_id)
          throw new AppError(
            403,
            "CUSTOMER_ACKNOWLEDGEMENT_INVALID",
            "The applicant must acknowledge handover.",
          );
        const vehicle = await repo.lockVehicle(assignment.vehicle_unit_id);
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
          condition: input.condition,
          accessories: input.accessories,
          headOfficeLocation: location,
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
            headOfficeLocation: location,
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

function isCompleteChecklist(value: Record<string, unknown>): boolean {
  if (value.complete === true) return true;
  const required = [
    "identityVerified",
    "keys",
    "conditionRecorded",
    "accessoriesRecorded",
  ];
  return required.every((key) => value[key] === true);
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
