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
import {
  requireProductionConnector,
  type TrackerPort,
} from "@somo/integrations";
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
  latitude: string;
  longitude: string;
  recordedAt: string;
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
    expectedVehicleVersion: number;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<{
    vehicleUnitId: string;
    registrationNumber: string;
    validTo: string;
    version: number;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  }>;
  recordInsurance(input: {
    vehicleUnitId: string;
    policyNumber: string;
    provider: string;
    validFrom: string;
    validTo: string;
    evidenceDocumentId?: string;
    expectedVehicleVersion: number;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<{
    vehicleUnitId: string;
    policyNumber: string;
    validTo: string;
    version: number;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  }>;
  associateTracker(input: {
    vehicleUnitId: string;
    trackerId: string;
    expectedVehicleVersion: number;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<{ vehicleUnitId: string; version: number }>;
  assignVehicle(input: {
    applicationId: string;
    vehicleUnitId: string;
    expectedVehicleVersion: number;
    previousAssignmentId?: string;
    reassignmentApproval?: {
      approvalId?: string;
      approvedBy?: string;
      reason?: string;
    };
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<AssignmentRecord>;
  requestReassignment(input: {
    applicationId: string;
    previousAssignmentId: string;
    requestedVehicleUnitId: string;
    reason: string;
    effectiveUntil?: string;
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<{ id: string; status: "PENDING"; effectiveFrom: string; effectiveUntil: string | null }>;
  approveReassignment(input: {
    approvalId: string;
    actor: StaffPrincipal;
    idempotencyKey: string;
    requestId: string;
  }): Promise<{ id: string; status: "APPROVED"; effectiveFrom: string; effectiveUntil: string | null }>;
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
  tracker?: TrackerPort;
  environment?: "test" | "production";
}): AssetService {
  const environment = options.environment ?? "test";
  const trackerPort = options.tracker;
  if (environment === "production" && trackerPort !== undefined) {
    try {
      requireProductionConnector(trackerPort, "TRACKER");
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? error.message
          : "PRODUCTION_CONNECTOR_CAPABILITY_REQUIRED",
      );
    }
  }
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
      const registrationNumber = requiredIdentifier(
        input.registrationNumber,
        "REGISTRATION_REQUIRED",
      );
      validateExpectedVehicleVersion(input.expectedVehicleVersion);
      const payloadHash = hashPayload({
        vehicleUnitId: input.vehicleUnitId,
        expectedVehicleVersion: input.expectedVehicleVersion,
        registrationNumber,
        validFrom: input.validFrom,
        validTo: input.validTo,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
      });
      const scope = `vehicle:${input.vehicleUnitId}:registration`;
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
        return replayRegistration(existing.response);
      }
      const now = new Date();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "VEHICLE_REGISTRATION",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            response: {},
          });
          if (!command.inserted) {
            if (
              command.payloadHash !== payloadHash ||
              command.actorStaffUserId !== input.actor.staffUserId
            )
              throw idempotencyConflict();
            return replayRegistration(command.response);
          }
          const vehicle = await repo.lockVehicle(input.vehicleUnitId);
          if (vehicle === null)
            throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
          await repo.insertRegistration({
            id: randomUUID(),
            vehicleUnitId: input.vehicleUnitId,
            registrationNumber,
            validFrom: input.validFrom,
            validTo: input.validTo,
            ...(input.evidenceDocumentId === undefined
              ? {}
              : { evidenceDocumentId: input.evidenceDocumentId }),
            now,
          });
          const updatedVehicle = await repo.updateVehicleRegistrationSummary(
            vehicle.id,
            input.expectedVehicleVersion,
            registrationNumber,
            now,
          );
          const response = {
            vehicleUnitId: input.vehicleUnitId,
            registrationNumber,
            validTo: input.validTo,
            version: updatedVehicle.version,
            renewalWarningState: "RENEWAL_REVIEW_REQUIRED" as const,
          };
          await repo.updateCommandResponse(scope, input.idempotencyKey, response);
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            action: "VEHICLE_REGISTRATION_RECORDED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { validTo: input.validTo, version: updatedVehicle.version },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "asset.vehicle.registration_recorded",
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            payload: response,
            occurredAt: now,
          });
          return response;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "REGISTRATION_DUPLICATE",
            "The registration is already recorded.",
          );
        if (error instanceof Error && error.message === "VEHICLE_VERSION_CONFLICT")
          throw new AppError(
            409,
            "STALE_VERSION",
            "The vehicle changed before registration was recorded.",
          );
        throw error;
      }
    },

    async recordInsurance(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      validateDateWindow(
        input.validFrom,
        input.validTo,
        "INSURANCE_DATE_INVALID",
      );
      const policyNumber = requiredIdentifier(
        input.policyNumber,
        "INSURANCE_REQUIRED",
      );
      const provider = requiredIdentifier(
        input.provider,
        "INSURANCE_PROVIDER_REQUIRED",
      );
      validateExpectedVehicleVersion(input.expectedVehicleVersion);
      const payloadHash = hashPayload({
        vehicleUnitId: input.vehicleUnitId,
        expectedVehicleVersion: input.expectedVehicleVersion,
        policyNumber,
        provider,
        validFrom: input.validFrom,
        validTo: input.validTo,
        evidenceDocumentId: input.evidenceDocumentId ?? null,
      });
      const scope = `vehicle:${input.vehicleUnitId}:insurance`;
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
        return replayInsurance(existing.response);
      }
      const now = new Date();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "VEHICLE_INSURANCE",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            response: {},
          });
          if (!command.inserted) {
            if (
              command.payloadHash !== payloadHash ||
              command.actorStaffUserId !== input.actor.staffUserId
            )
              throw idempotencyConflict();
            return replayInsurance(command.response);
          }
          const vehicle = await repo.lockVehicle(input.vehicleUnitId);
          if (vehicle === null)
            throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
          await repo.insertInsurance({
            id: randomUUID(),
            vehicleUnitId: input.vehicleUnitId,
            policyNumber,
            provider,
            validFrom: input.validFrom,
            validTo: input.validTo,
            ...(input.evidenceDocumentId === undefined
              ? {}
              : { evidenceDocumentId: input.evidenceDocumentId }),
            now,
          });
          const updatedVehicle = await repo.bumpVehicleVersion(
            vehicle.id,
            input.expectedVehicleVersion,
            now,
          );
          const response = {
            vehicleUnitId: input.vehicleUnitId,
            policyNumber,
            validTo: input.validTo,
            version: updatedVehicle.version,
            renewalWarningState: "RENEWAL_REVIEW_REQUIRED" as const,
          };
          await repo.updateCommandResponse(scope, input.idempotencyKey, response);
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            action: "VEHICLE_INSURANCE_RECORDED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { validTo: input.validTo, version: updatedVehicle.version },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "asset.vehicle.insurance_recorded",
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            payload: response,
            occurredAt: now,
          });
          return response;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "INSURANCE_DUPLICATE",
            "The insurance policy is already recorded.",
          );
        if (error instanceof Error && error.message === "VEHICLE_VERSION_CONFLICT")
          throw new AppError(
            409,
            "STALE_VERSION",
            "The vehicle changed before insurance was recorded.",
          );
        throw error;
      }
    },

    async associateTracker(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      const trackerId = requiredIdentifier(
        input.trackerId,
        "TRACKER_IDENTIFIER_REQUIRED",
      );
      if (trackerPort === undefined) {
        throw new AppError(
          503,
          "TRACKER_CAPABILITY_UNAVAILABLE",
          "An attested read-only tracker capability is required.",
        );
      }
      validateExpectedVehicleVersion(input.expectedVehicleVersion);
      const payloadHash = hashPayload({
        vehicleUnitId: input.vehicleUnitId,
        expectedVehicleVersion: input.expectedVehicleVersion,
        trackerId,
      });
      const scope = `vehicle:${input.vehicleUnitId}:tracker-associate`;
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
        return replayTrackerAssociation(existing.response);
      }
      const now = new Date();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = assetContractRepo(tx);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "TRACKER_ASSOCIATE",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            response: {},
          });
          if (!command.inserted) {
            if (
              command.payloadHash !== payloadHash ||
              command.actorStaffUserId !== input.actor.staffUserId
            )
              throw idempotencyConflict();
            return replayTrackerAssociation(command.response);
          }
          const vehicle = await repo.lockVehicle(input.vehicleUnitId);
          if (vehicle === null)
            throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
          await repo.insertTracker({
            id: randomUUID(),
            vehicleUnitId: input.vehicleUnitId,
            trackerId,
            associatedAt: now,
          });
          const updatedVehicle = await repo.updateVehicleTrackerIdentifier(
            vehicle.id,
            input.expectedVehicleVersion,
            trackerId,
            now,
          );
          const response = {
            vehicleUnitId: vehicle.id,
            version: updatedVehicle.version,
          };
          await repo.updateCommandResponse(scope, input.idempotencyKey, response);
          await appendAuditEvent(tx, {
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            action: "TRACKER_ASSOCIATED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { trackerId, trackerConfigured: true, locationOnly: true },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "asset.vehicle.tracker_associated",
            aggregateType: "vehicle_unit",
            aggregateId: vehicle.id,
            payload: response,
            occurredAt: now,
          });
          return response;
        });
      } catch (error) {
        if (isUniqueViolation(error))
          throw new AppError(
            409,
            "TRACKER_IDENTIFIER_DUPLICATE",
            "The tracker is already associated.",
          );
        if (error instanceof Error && error.message === "VEHICLE_VERSION_CONFLICT")
          throw new AppError(
            409,
            "STALE_VERSION",
            "The vehicle changed before tracker association was recorded.",
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
        reassignmentApproval: input.reassignmentApproval?.approvalId ?? null,
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
            const existingContract = await repo.findContractByApplication(
              input.applicationId,
            );
            if (existingContract !== null) {
              throw new AppError(
                409,
                "CONTRACT_REASSIGNMENT_BLOCKED",
                "A generated contract binds the assigned vehicle; reassignment is denied.",
              );
            }
            if (input.previousAssignmentId !== current.id) {
              throw new AppError(
                409,
                "REASSIGNMENT_APPROVAL_REQUIRED",
                "An existing assignment requires an explicit reassignment approval.",
              );
            }
            if (
              input.reassignmentApproval === undefined ||
              typeof input.reassignmentApproval.approvalId !== "string"
            ) {
              throw new AppError(
                403,
                "REASSIGNMENT_APPROVAL_REQUIRED",
                "A persisted independent reassignment approval is required.",
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
          const reassignmentApproval =
            current === null || input.reassignmentApproval === undefined
              ? null
              : await repo.findEffectiveReassignmentApproval({
                  id: input.reassignmentApproval.approvalId!,
                  applicationId: input.applicationId,
                  previousAssignmentId: current.id,
                  requestedVehicleUnitId: input.vehicleUnitId,
                  now,
                });
          if (current !== null && reassignmentApproval === null) {
            throw new AppError(
              403,
              "REASSIGNMENT_APPROVAL_REQUIRED",
              "The persisted reassignment approval is missing, expired, or not bound to this assignment and vehicle.",
            );
          }
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
                  reassignmentApprovedBy: reassignmentApproval!.approved_by!,
                  reassignmentReason: reassignmentApproval!.reason.trim(),
                }),
            assignedBy: input.actor.staffUserId,
            assignedAt: now,
          });
          if (
            application.status === "APPROVED" ||
            application.status === "AWAITING_ASSET_ASSIGNMENT"
          ) {
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
                    reassignmentReason: reassignmentApproval!.reason.trim(),
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

    async requestReassignment(input) {
      requireRole(input.actor, "INVENTORY_OFFICER");
      const reason = requiredIdentifier(
        input.reason,
        "REASSIGNMENT_REASON_REQUIRED",
      );
      const payloadHash = hashPayload({
        applicationId: input.applicationId,
        previousAssignmentId: input.previousAssignmentId,
        requestedVehicleUnitId: input.requestedVehicleUnitId,
        reason,
        effectiveUntil: input.effectiveUntil ?? null,
      });
      const scope = `application:${input.applicationId}:reassignment-request`;
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
        return replayReassignmentCapability(existing.response, "PENDING");
      }
      const now = new Date();
      const effectiveUntil =
        input.effectiveUntil === undefined
          ? null
          : parseDateOnly(input.effectiveUntil, "REASSIGNMENT_WINDOW_INVALID");
      if (effectiveUntil !== null && effectiveUntil <= now)
        throw new AppError(
          409,
          "REASSIGNMENT_WINDOW_INVALID",
          "The reassignment approval must remain effective after now.",
        );
      return withTransaction(options.database, async (tx) => {
        const repo = assetContractRepo(tx);
        const application = await repo.findApplication(input.applicationId, true);
        if (application === null)
          throw notFound("APPLICATION_NOT_FOUND", "Application not found.");
        const current = await repo.currentAssignment(input.applicationId, true);
        if (current === null || current.id !== input.previousAssignmentId)
          throw new AppError(
            409,
            "ASSIGNMENT_STALE",
            "The reassignment request is not bound to the current assignment.",
          );
        const contract = await repo.findContractByApplication(input.applicationId);
        if (contract !== null)
          throw new AppError(
            409,
            "CONTRACT_REASSIGNMENT_BLOCKED",
            "A generated contract binds the assigned vehicle; reassignment is denied.",
          );
        const target = await repo.lockVehicle(input.requestedVehicleUnitId);
        if (target === null)
          throw notFound("VEHICLE_NOT_FOUND", "Vehicle not found.");
        const requestedByRole = input.actor.roles[0] ?? "INVENTORY_OFFICER";
        const approval = await repo.insertReassignmentApproval({
          id: randomUUID(),
          applicationId: input.applicationId,
          previousAssignmentId: current.id,
          requestedVehicleUnitId: target.id,
          requestedBy: input.actor.staffUserId,
          requestedByRole,
          reason,
          effectiveFrom: now,
          ...(effectiveUntil === null ? {} : { effectiveUntil }),
        });
        const response = {
          id: approval.id,
          status: "PENDING" as const,
          effectiveFrom: toDate(approval.effective_from).toISOString(),
          effectiveUntil:
            approval.effective_until === null
              ? null
              : toDate(approval.effective_until).toISOString(),
        };
        const command = await repo.insertCommand({
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: "REASSIGNMENT_REQUEST",
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
          return replayReassignmentCapability(command.response, "PENDING");
        }
        await repo.updateCommandResponse(scope, input.idempotencyKey, response);
        await appendAuditEvent(tx, {
          aggregateType: "vehicle_assignment",
          aggregateId: current.id,
          action: "REASSIGNMENT_REQUESTED",
          actorStaffUserId: input.actor.staffUserId,
          requestId: input.requestId,
          data: {
            approvalId: approval.id,
            requestedVehicleUnitId: target.id,
            reason,
            requestedByRole,
          },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "asset.vehicle.reassignment_requested",
          aggregateType: "vehicle_assignment",
          aggregateId: current.id,
          payload: response,
          occurredAt: now,
        });
        return response;
      });
    },

    async approveReassignment(input) {
      if (
        !input.actor.roles.some((role) =>
          ["INVENTORY_OFFICER", "AGM", "MD"].includes(role),
        )
      )
        throw new AppError(
          403,
          "FORBIDDEN",
          "This staff role cannot approve a reassignment.",
        );
      const payloadHash = hashPayload({ approvalId: input.approvalId });
      const scope = `reassignment:${input.approvalId}:approve`;
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
        return replayReassignmentCapability(existing.response, "APPROVED");
      }
      const now = new Date();
      return withTransaction(options.database, async (tx) => {
        const repo = assetContractRepo(tx);
        const pending = await repo.findReassignmentApproval(input.approvalId, true);
        if (pending === null)
          throw notFound("REASSIGNMENT_APPROVAL_NOT_FOUND", "Reassignment approval not found.");
        if (pending.requested_by === input.actor.staffUserId)
          throw new AppError(
            403,
            "REASSIGNMENT_APPROVER_INDEPENDENCE_REQUIRED",
            "The requester cannot approve their own reassignment.",
          );
        if (pending.status !== "PENDING")
          throw new AppError(
            409,
            "REASSIGNMENT_APPROVAL_STATE_INVALID",
            "The reassignment approval is no longer pending.",
          );
        const approvedByRole = input.actor.roles[0] ?? "INVENTORY_OFFICER";
        const approval = await repo.approveReassignmentApproval({
          id: pending.id,
          approvedBy: input.actor.staffUserId,
          approvedByRole,
          approvedAt: now,
          now,
        });
        if (approval === null)
          throw new AppError(
            409,
            "REASSIGNMENT_APPROVAL_STATE_INVALID",
            "The reassignment approval expired or was approved concurrently.",
          );
        const response = {
          id: approval.id,
          status: "APPROVED" as const,
          effectiveFrom: toDate(approval.effective_from).toISOString(),
          effectiveUntil:
            approval.effective_until === null
              ? null
              : toDate(approval.effective_until).toISOString(),
        };
        const command = await repo.insertCommand({
          scope,
          idempotencyKey: input.idempotencyKey,
          commandType: "REASSIGNMENT_APPROVE",
          payloadHash,
          actorStaffUserId: input.actor.staffUserId,
          applicationId: approval.application_id,
          response,
        });
        if (!command.inserted) {
          if (
            command.payloadHash !== payloadHash ||
            command.actorStaffUserId !== input.actor.staffUserId
          )
            throw idempotencyConflict();
          return replayReassignmentCapability(command.response, "APPROVED");
        }
        await repo.updateCommandResponse(scope, input.idempotencyKey, response);
        await appendAuditEvent(tx, {
          aggregateType: "vehicle_assignment",
          aggregateId: approval.previous_assignment_id,
          action: "REASSIGNMENT_APPROVED",
          actorStaffUserId: input.actor.staffUserId,
          requestId: input.requestId,
          data: {
            approvalId: approval.id,
            requestedBy: approval.requested_by,
            requestedByRole: approval.requested_by_role,
            approvedByRole,
            reason: approval.reason,
            effectiveFrom: approval.effective_from,
            effectiveUntil: approval.effective_until,
          },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "asset.vehicle.reassignment_approved",
          aggregateType: "vehicle_assignment",
          aggregateId: approval.previous_assignment_id,
          payload: response,
          occurredAt: now,
        });
        return response;
      });
    },

    async getAssignment(applicationId) {
      const row = await assetContractRepo(options.database).currentAssignment(
        applicationId,
      );
      return row === null ? null : serializeAssignment(row);
    },

    async getTrackerAccess(input) {
      requireRole(input.actor, "RECOVERY_OFFICER");
      if (trackerPort === undefined)
        throw new AppError(
          503,
          "TRACKER_CAPABILITY_UNAVAILABLE",
          "An attested read-only tracker capability is required.",
        );
      const association = await assetContractRepo(options.database).currentTracker(
        input.vehicleUnitId,
      );
      if (association === null || association.tracker_identifier === null)
        throw new AppError(
          404,
          "TRACKER_LOCATION_UNAVAILABLE",
          "No last-known tracker location is available.",
        );
      const location = await trackerPort.getLastKnown({
        trackerId: association.tracker_identifier,
      });
      if (location === null)
        throw new AppError(
          404,
          "TRACKER_LOCATION_UNAVAILABLE",
          "No last-known tracker location is available.",
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
        latitude: location.latitude,
        longitude: location.longitude,
        recordedAt: location.recordedAt,
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
  const fromDate = new Date(`${from}T00:00:00.000Z`);
  if (fromDate.getTime() > Date.now())
    throw new AppError(
      409,
      code,
      "A coverage record cannot begin in the future.",
    );
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

function validateExpectedVehicleVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new AppError(
      400,
      "VERSION_INVALID",
      "The vehicle version is invalid.",
    );
}

function parseDateOnly(value: string, code: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    throw new AppError(400, code, "The date is invalid.");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    throw new AppError(400, code, "The date is invalid.");
  return parsed;
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
    trackerIdentifier: null,
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

function replayRegistration(value: Record<string, unknown>): {
  vehicleUnitId: string;
  registrationNumber: string;
  validTo: string;
  version: number;
  renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
} {
  if (
    typeof value.vehicleUnitId !== "string" ||
    typeof value.registrationNumber !== "string" ||
    typeof value.validTo !== "string" ||
    typeof value.version !== "number"
  )
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved registration command is invalid.",
    );
  return value as {
    vehicleUnitId: string;
    registrationNumber: string;
    validTo: string;
    version: number;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  };
}

function replayInsurance(value: Record<string, unknown>): {
  vehicleUnitId: string;
  policyNumber: string;
  validTo: string;
  version: number;
  renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
} {
  if (
    typeof value.vehicleUnitId !== "string" ||
    typeof value.policyNumber !== "string" ||
    typeof value.validTo !== "string" ||
    typeof value.version !== "number"
  )
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved insurance command is invalid.",
    );
  return value as {
    vehicleUnitId: string;
    policyNumber: string;
    validTo: string;
    version: number;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  };
}

function replayTrackerAssociation(value: Record<string, unknown>): {
  vehicleUnitId: string;
  version: number;
} {
  if (typeof value.vehicleUnitId !== "string" || typeof value.version !== "number")
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved tracker command is invalid.",
    );
  return value as { vehicleUnitId: string; version: number };
}

function replayReassignmentCapability<S extends "PENDING" | "APPROVED">(
  value: Record<string, unknown>,
  status: S,
): {
  id: string;
  status: S;
  effectiveFrom: string;
  effectiveUntil: string | null;
} {
  if (
    typeof value.id !== "string" ||
    value.status !== status ||
    typeof value.effectiveFrom !== "string" ||
    (value.effectiveUntil !== null && typeof value.effectiveUntil !== "string")
  )
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved reassignment command is invalid.",
    );
  return value as {
    id: string;
    status: S;
    effectiveFrom: string;
    effectiveUntil: string | null;
  };
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
