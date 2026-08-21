import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  assetContractRepo,
  enqueueOutbox,
  withTransaction,
  type AssignmentRow,
  type Database,
  type VehicleRow,
} from "@somo/db";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface VehicleRecord extends Record<string, unknown> {
  id: string;
  vehicleModelId: string;
  vin: string;
  chassisNumber: string;
  engineMotorIdentifier: string | null;
  condition: Record<string, unknown>;
  accessories: readonly string[];
  trackerIdentifier: string | null;
  registrationNumber: string | null;
  status: string;
  version: number;
}

export interface AssignmentRecord extends Record<string, unknown> {
  id: string;
  applicationId: string;
  vehicleUnitId: string;
  offerId: string;
  offerVersionId: string;
  depositReconciledAmountMinor: string;
  depositEvidenceId: string;
  supersedesAssignmentId: string | null;
  assignedAt: string;
  version: number;
}

export interface TrackerAccessRecord {
  vehicleUnitId: string;
  trackerIdentifier: string | null;
  provider: string;
  providerDeviceId: string;
  deepLink: string;
  accessedAt: string;
}

export interface AssetService {
  registerVehicle(input: {
    vehicleModelId: string;
    vin: string;
    chassisNumber: string;
    engineMotorIdentifier: string;
    condition: Record<string, unknown>;
    accessories: readonly string[];
    trackerIdentifier?: string;
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<VehicleRecord>;
  listInventory(actor: StaffPrincipal): Promise<VehicleRecord[]>;
  recordRegistration(input: {
    vehicleUnitId: string;
    registrationNumber: string;
    validFrom: string;
    validTo: string;
    evidenceDocumentId?: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<{
    vehicleUnitId: string;
    registrationNumber: string;
    validTo: string;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  }>;
  recordInsurance(input: {
    vehicleUnitId: string;
    policyNumber: string;
    provider: string;
    validFrom: string;
    validTo: string;
    evidenceDocumentId?: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<{
    vehicleUnitId: string;
    policyNumber: string;
    validTo: string;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  }>;
  associateTracker(input: {
    vehicleUnitId: string;
    provider: string;
    providerDeviceId: string;
    deepLink: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<void>;
  assignVehicle(input: {
    applicationId: string;
    vehicleUnitId: string;
    expectedVehicleVersion: number;
    previousAssignmentId?: string;
    reassignmentApproval?: { approvedBy: string; reason: string };
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<AssignmentRecord>;
  getAssignment(applicationId: string): Promise<AssignmentRecord | null>;
  getTrackerAccess(input: {
    vehicleUnitId: string;
    purpose: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<TrackerAccessRecord>;
}

export function createAssetService(options: {
  database: Database;
}): AssetService {
  return {
    async registerVehicle(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      const vin = requiredIdentifier(input.vin, "VEHICLE_IDENTIFIER_REQUIRED");
      const chassisNumber = requiredIdentifier(
        input.chassisNumber,
        "VEHICLE_IDENTIFIER_REQUIRED",
      );
      const engineMotorIdentifier = requiredIdentifier(
        input.engineMotorIdentifier,
        "VEHICLE_IDENTIFIER_REQUIRED",
      );
      const payloadHash = hashPayload({
        vehicleModelId: input.vehicleModelId,
        vin,
        chassisNumber,
        engineMotorIdentifier,
        condition: input.condition,
        accessories: input.accessories,
        trackerIdentifier: input.trackerIdentifier ?? null,
      });
      const scope = `vehicle:${vin}:register`;
      const existing = await assetContractRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (
          existing.payloadHash !== payloadHash ||
          existing.actorStaffUserId !== input.actor.staffUserId
        ) {
          throw idempotencyConflict();
        }
        return replayVehicle(existing.response);
      }
      const now = new Date();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "VEHICLE_REGISTER",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            response: {},
          });
          if (!command.inserted) {
            if (
              command.payloadHash !== payloadHash ||
              command.actorStaffUserId !== input.actor.staffUserId
            ) {
              throw idempotencyConflict();
            }
            return replayVehicle(command.response);
          }
          const vehicle = await repo.insertVehicle({
            id: randomUUID(),
            vehicleModelId: input.vehicleModelId,
            vin,
            chassisNumber,
            engineMotorIdentifier,
            condition: input.condition,
            accessories: input.accessories,
            ...(input.trackerIdentifier === undefined
              ? {}
              : { trackerIdentifier: input.trackerIdentifier }),
            now,
          });
          const response = serializeVehicle(vehicle);
          await repo.updateCommandResponse(
            scope,
            input.idempotencyKey,
            response,
          );
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            action: "VEHICLE_REGISTERED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              vehicleModelId: vehicle.vehicle_model_id,
              status: vehicle.status,
            },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "asset.vehicle.registered",
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            payload: response,
            occurredAt: now,
          });
          return response;
        });
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new AppError(
            409,
            "VEHICLE_IDENTIFIER_DUPLICATE",
            "The VIN, chassis, or tracker identifier is already registered.",
          );
        }
        throw error;
      }
    },

    async listInventory(actor) {
      requireRole(actor, "INVENTORY_OFFICER");
      return (await assetContractRepo(options.database).listVehicles()).map(
        serializeVehicle,
      );
    },

    async recordRegistration(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      validateDateWindow(
        input.validFrom,
        input.validTo,
        "REGISTRATION_DATE_INVALID",
      );
      const now = new Date();
      try {
        await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const vehicle = await repo.lockVehicle(input.vehicleUnitId);
          if (vehicle === null)
            throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
          await repo.insertRegistration({
            id: randomUUID(),
            vehicleUnitId: input.vehicleUnitId,
            registrationNumber: requiredIdentifier(
              input.registrationNumber,
              "REGISTRATION_REQUIRED",
            ),
            validFrom: input.validFrom,
            validTo: input.validTo,
            ...(input.evidenceDocumentId === undefined
              ? {}
              : { evidenceDocumentId: input.evidenceDocumentId }),
            now,
          });
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            action: "VEHICLE_REGISTRATION_RECORDED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { validTo: input.validTo },
            occurredAt: now,
          });
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "REGISTRATION_DUPLICATE",
            "The registration is already recorded.",
          );
        throw error;
      }
      return {
        vehicleUnitId: input.vehicleUnitId,
        registrationNumber: input.registrationNumber.trim(),
        validTo: input.validTo,
        renewalWarningState: "RENEWAL_REVIEW_REQUIRED" as const,
      };
    },

    async recordInsurance(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      validateDateWindow(
        input.validFrom,
        input.validTo,
        "INSURANCE_DATE_INVALID",
      );
      const now = new Date();
      try {
        await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const vehicle = await repo.lockVehicle(input.vehicleUnitId);
          if (vehicle === null)
            throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
          await repo.insertInsurance({
            id: randomUUID(),
            vehicleUnitId: input.vehicleUnitId,
            policyNumber: requiredIdentifier(
              input.policyNumber,
              "INSURANCE_REQUIRED",
            ),
            provider: requiredIdentifier(
              input.provider,
              "INSURANCE_PROVIDER_REQUIRED",
            ),
            validFrom: input.validFrom,
            validTo: input.validTo,
            ...(input.evidenceDocumentId === undefined
              ? {}
              : { evidenceDocumentId: input.evidenceDocumentId }),
            now,
          });
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            action: "VEHICLE_INSURANCE_RECORDED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { validTo: input.validTo },
            occurredAt: now,
          });
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "INSURANCE_DUPLICATE",
            "The insurance policy is already recorded.",
          );
        throw error;
      }
      return {
        vehicleUnitId: input.vehicleUnitId,
        policyNumber: input.policyNumber.trim(),
        validTo: input.validTo,
        renewalWarningState: "RENEWAL_REVIEW_REQUIRED" as const,
      };
    },

    async associateTracker(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      const provider = requiredIdentifier(
        input.provider,
        "TRACKER_PROVIDER_REQUIRED",
      );
      const providerDeviceId = requiredIdentifier(
        input.providerDeviceId,
        "TRACKER_IDENTIFIER_REQUIRED",
      );
      const deepLink = requiredIdentifier(
        input.deepLink,
        "TRACKER_LINK_REQUIRED",
      );
      if (!/^https:\/\//.test(deepLink)) {
        throw new AppError(
          400,
          "TRACKER_LINK_INVALID",
          "The tracker link is invalid.",
        );
      }
      const now = new Date();
      try {
        await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const vehicle = await repo.lockVehicle(input.vehicleUnitId);
          if (vehicle === null)
            throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
          await repo.insertTracker({
            id: randomUUID(),
            vehicleUnitId: input.vehicleUnitId,
            provider,
            providerDeviceId,
            deepLink,
            associatedAt: now,
          });
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            action: "TRACKER_ASSOCIATED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { provider, providerDeviceId },
            occurredAt: now,
          });
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "TRACKER_IDENTIFIER_DUPLICATE",
            "The tracker is already associated.",
          );
        throw error;
      }
    },

    async assignVehicle(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      if (
        !Number.isSafeInteger(input.expectedVehicleVersion) ||
        input.expectedVehicleVersion < 1
      ) {
        throw new AppError(
          400,
          "VERSION_INVALID",
          "The vehicle version is invalid.",
        );
      }
      const payloadHash = hashPayload({
        applicationId: input.applicationId,
        vehicleUnitId: input.vehicleUnitId,
        expectedVehicleVersion: input.expectedVehicleVersion,
        previousAssignmentId: input.previousAssignmentId ?? null,
        reassignmentApproval: input.reassignmentApproval ?? null,
      });
      const scope = `application:${input.applicationId}:vehicle-assign`;
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
        return replayAssignment(existing.response);
      }
      const now = new Date();
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
            application.status !== "AWAITING_ASSET_ASSIGNMENT" &&
            application.status !== "AWAITING_EXECUTION"
          ) {
            throw new AppError(
              409,
              "MD_APPROVAL_REQUIRED",
              "MD approval is required before assigning a vehicle.",
            );
          }
          const offer = await repo.lockOfferByApplication(input.applicationId);
          if (
            offer === null ||
            offer.status !== "ACCEPTED" ||
            offer.accepted_version_id === null ||
            offer.offer_version_id === null ||
            offer.expires_at === null ||
            new Date(offer.expires_at).getTime() <= now.getTime()
          ) {
            throw new AppError(
              409,
              "ACCEPTED_LOCKED_OFFER_REQUIRED",
              "A current accepted locked offer is required.",
            );
          }
          const vehicle = await repo.lockVehicle(input.vehicleUnitId);
          if (vehicle === null)
            throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
          if (vehicle.vehicle_model_id !== application.vehicle_model_id) {
            throw new AppError(
              409,
              "VEHICLE_MODEL_MISMATCH",
              "The vehicle model does not match the application.",
            );
          }
          const current = await repo.currentAssignment(
            input.applicationId,
            true,
          );
          if (current !== null) {
            if (input.previousAssignmentId !== current.id) {
              throw new AppError(
                409,
                "REASSIGNMENT_APPROVAL_REQUIRED",
                "An existing assignment requires an explicit reassignment approval.",
              );
            }
            if (
              input.reassignmentApproval === undefined ||
              input.reassignmentApproval.reason.trim().length === 0 ||
              input.reassignmentApproval.approvedBy === input.actor.staffUserId
            ) {
              throw new AppError(
                403,
                "REASSIGNMENT_APPROVAL_REQUIRED",
                "An independent authorized reassignment approval and reason are required.",
              );
            }
          } else if (input.previousAssignmentId !== undefined) {
            throw new AppError(
              409,
              "ASSIGNMENT_STALE",
              "The previous assignment is stale.",
            );
          }
          const deposit = await repo.findDeposit(input.applicationId, offer.id);
          const requiredDeposit = BigInt(offer.deposit_minor_units ?? 0);
          if (
            deposit === null ||
            BigInt(deposit.amount_minor_units) < requiredDeposit
          ) {
            throw new AppError(
              409,
              "DEPOSIT_RECONCILIATION_REQUIRED",
              "A reconciled deposit meeting the locked amount is required.",
            );
          }
          const coverage = await repo.findCurrentInsuranceRegistration(
            vehicle.id,
          );
          if (
            coverage === null ||
            coverage.registration_valid_to === null ||
            coverage.insurance_valid_to === null ||
            !dateIsCurrent(coverage.registration_valid_to, now) ||
            !dateIsCurrent(coverage.insurance_valid_to, now)
          ) {
            throw new AppError(
              409,
              "REGISTRATION_INSURANCE_REQUIRED",
              "Current registration and insurance are required before assignment.",
            );
          }
          if (current !== null) {
            const oldVehicle = await repo.lockVehicle(current.vehicle_unit_id);
            if (oldVehicle !== null && oldVehicle.id !== vehicle.id) {
              await repo.updateVehicleStatus(
                oldVehicle.id,
                oldVehicle.version,
                "IN_STOCK",
                now,
              );
            }
            await repo.releaseAssignment(current.id, current.version, now);
          }
          if (
            vehicle.status !== "IN_STOCK" &&
            vehicle.id !== current?.vehicle_unit_id
          ) {
            throw new AppError(
              409,
              "VEHICLE_NOT_AVAILABLE",
              "The vehicle is not available for assignment.",
            );
          }
          const updatedVehicle =
            vehicle.id === current?.vehicle_unit_id
              ? vehicle
              : await repo.updateVehicleStatus(
                  vehicle.id,
                  input.expectedVehicleVersion,
                  "ASSIGNED",
                  now,
                );
          const assignment = await repo.insertAssignment({
            id: randomUUID(),
            applicationId: input.applicationId,
            vehicleUnitId: updatedVehicle.id,
            offerId: offer.id,
            offerVersionId: offer.offer_version_id,
            depositAmountMinor: BigInt(deposit.amount_minor_units),
            depositEvidenceId: deposit.id,
            ...(current === null
              ? {}
              : {
                  supersedesAssignmentId: current.id,
                  reassignmentApprovedBy:
                    input.reassignmentApproval!.approvedBy,
                  reassignmentReason: input.reassignmentApproval!.reason.trim(),
                }),
            assignedBy: input.actor.staffUserId,
            assignedAt: now,
          });
          if (application.status === "APPROVED") {
            await repo.updateApplicationStatus({
              id: application.id,
              expectedVersion: application.version,
              status: "AWAITING_EXECUTION",
              now,
            });
          }
          const response = serializeAssignment(assignment);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "VEHICLE_ASSIGN",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            applicationId: input.applicationId,
            response,
          });
          if (!command.inserted) {
            if (
              command.payloadHash !== payloadHash ||
              command.actorStaffUserId !== input.actor.staffUserId
            )
              throw idempotencyConflict();
            return replayAssignment(command.response);
          }
          await repo.updateCommandResponse(
            scope,
            input.idempotencyKey,
            response,
          );
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_assignment",
            aggregateId: assignment.id,
            action:
              current === null ? "VEHICLE_ASSIGNED" : "VEHICLE_REASSIGNED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              applicationId: input.applicationId,
              vehicleUnitId: updatedVehicle.id,
              depositEvidenceId: deposit.id,
              ...(current === null
                ? {}
                : {
                    supersedesAssignmentId: current.id,
                    reassignmentReason:
                      input.reassignmentApproval!.reason.trim(),
                  }),
            },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic:
              current === null
                ? "asset.vehicle.assigned"
                : "asset.vehicle.reassigned",
            aggregateType: "vehicle_assignment",
            aggregateId: assignment.id,
            payload: response,
            occurredAt: now,
          });
          return response;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "ASSIGNMENT_CONFLICT",
            "The vehicle assignment changed concurrently.",
          );
        if (
          error instanceof Error &&
          error.message === "VEHICLE_VERSION_CONFLICT"
        )
          throw new AppError(
            409,
            "STALE_VERSION",
            "The vehicle changed before assignment.",
          );
        throw error;
      }
    },

    async getAssignment(applicationId) {
      const row = await assetContractRepo(options.database).currentAssignment(
        applicationId,
      );
      return row === null ? null : serializeAssignment(row);
    },

    async getTrackerAccess(input) {
      requireRole(input.actor, "RECOVERY_OFFICER");
      const tracker = await assetContractRepo(options.database).currentTracker(
        input.vehicleUnitId,
      );
      if (tracker === null)
        throw new AppError(
          404,
          "TRACKER_NOT_FOUND",
          "No active tracker association was found.",
        );
      const now = new Date();
      await withTransaction(options.database, async (tx) => {
        await assetContractRepo(tx).insertTrackerAccess({
          id: randomUUID(),
          vehicleUnitId: input.vehicleUnitId,
          staffUserId: input.actor.staffUserId,
          purpose: requiredIdentifier(
            input.purpose,
            "TRACKER_PURPOSE_REQUIRED",
          ),
          accessedAt: now,
          context: { locationOnly: true },
        });
        await appendAuditEvent(tx, {
          aggregateType: "vehicle_unit",
          aggregateId: input.vehicleUnitId,
          action: "TRACKER_LOCATION_ACCESS",
          actorStaffUserId: input.actor.staffUserId,
          requestId: input.requestId,
          data: { purpose: input.purpose.trim(), locationOnly: true },
          occurredAt: now,
        });
      });
      return {
        vehicleUnitId: input.vehicleUnitId,
        trackerIdentifier: tracker.tracker_identifier,
        provider: tracker.provider,
        providerDeviceId: tracker.provider_device_id,
        deepLink: tracker.deep_link,
        accessedAt: now.toISOString(),
      };
    },
  };
}

function requireRole(actor: StaffPrincipal, role: StaffRole): void {
  if (!actor.roles.includes(role)) {
    throw new AppError(
      403,
      "FORBIDDEN",
      "This inventory control is not permitted for the staff role.",
    );
  }
}

type StaffRole = StaffPrincipal["roles"][number];

function requiredIdentifier(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 256)
    throw new AppError(400, code, "A required identifier is missing.");
  return normalized;
}

function validateDateWindow(from: string, to: string, code: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to) ||
    Number.isNaN(Date.parse(`${from}T00:00:00Z`)) ||
    Number.isNaN(Date.parse(`${to}T00:00:00Z`)) ||
    to < from
  ) {
    throw new AppError(400, code, "The validity dates are invalid.");
  }
}

function dateIsCurrent(value: string | Date, now: Date): boolean {
  const date =
    value instanceof Date ? value : new Date(`${value}T23:59:59.999Z`);
  return Number.isFinite(date.getTime()) && date.getTime() >= now.getTime();
}

function serializeVehicle(row: VehicleRow): VehicleRecord {
  return {
    id: row.id,
    vehicleModelId: row.vehicle_model_id,
    vin: row.vin,
    chassisNumber: row.chassis_number,
    engineMotorIdentifier: row.engine_motor_identifier,
    condition: row.condition,
    accessories: row.accessories,
    trackerIdentifier: row.tracker_identifier,
    registrationNumber: row.registration_number,
    status: row.status,
    version: row.version,
  };
}

function serializeAssignment(row: AssignmentRow): AssignmentRecord {
  if (
    row.offer_id === null ||
    row.offer_version_id === null ||
    row.deposit_reconciled_amount_minor_units === null ||
    row.deposit_evidence_id === null
  ) {
    throw new Error("ASSIGNMENT_EVIDENCE_INVALID");
  }
  return {
    id: row.id,
    applicationId: row.application_id,
    vehicleUnitId: row.vehicle_unit_id,
    offerId: row.offer_id,
    offerVersionId: row.offer_version_id,
    depositReconciledAmountMinor: BigInt(
      row.deposit_reconciled_amount_minor_units,
    ).toString(),
    depositEvidenceId: row.deposit_evidence_id,
    supersedesAssignmentId: row.supersedes_assignment_id,
    assignedAt: toDate(row.assigned_at).toISOString(),
    version: row.version,
  };
}

function replayVehicle(value: Record<string, unknown>): VehicleRecord {
  if (
    typeof value.id !== "string" ||
    typeof value.vehicleModelId !== "string" ||
    typeof value.vin !== "string" ||
    typeof value.chassisNumber !== "string" ||
    typeof value.status !== "string" ||
    typeof value.version !== "number"
  )
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved vehicle command is invalid.",
    );
  return value as unknown as VehicleRecord;
}

function replayAssignment(value: Record<string, unknown>): AssignmentRecord {
  if (
    typeof value.id !== "string" ||
    typeof value.applicationId !== "string" ||
    typeof value.vehicleUnitId !== "string"
  )
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved assignment command is invalid.",
    );
  return value as unknown as AssignmentRecord;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function idempotencyConflict(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
    "The idempotency key was reused with a different command.",
  );
}

function notFound(code: string, detail: string): AppError {
  return new AppError(404, code, detail);
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    if (typeof current !== "object") return false;
    if ("code" in current && current.code === "23505") return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
