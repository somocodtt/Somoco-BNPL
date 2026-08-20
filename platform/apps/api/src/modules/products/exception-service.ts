import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  enqueueOutbox,
  financingRepo,
  withTransaction,
  type Database,
  type ExceptionRecord,
} from "@somo/db";
import type { StaffPrincipal, StaffRole } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

const approverRoles: readonly StaffRole[] = [
  "PRODUCT_ADMIN",
  "BSM",
  "AGM",
  "CFO",
  "MD",
  "COMPLIANCE_AUDITOR",
];

export interface ExceptionService {
  request(input: {
    applicationId: string;
    proposedValue: unknown;
    policyValue: unknown;
    reason: string;
    requiredApproverRole: StaffRole;
    expiresAt?: string;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<ExceptionRecord>;
  decide(input: {
    exceptionId: string;
    expectedVersion: number;
    decision: "APPROVE" | "REJECT";
    reason: string;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<ExceptionRecord>;
  findApproved(applicationId: string, now?: Date): Promise<ExceptionRecord | null>;
}

export function createExceptionService(options: {
  database: Database;
}): ExceptionService {
  return {
    async request(input) {
      assertStaffActor(input.actor);
      assertRole(input.requiredApproverRole);
      const reason = normalizeReason(input.reason);
      const expiresAt =
        input.expiresAt === undefined
          ? undefined
          : parseDate(input.expiresAt, "EXCEPTION_EXPIRY_INVALID");
      if (expiresAt !== undefined && expiresAt <= new Date()) {
        throw new AppError(400, "EXCEPTION_EXPIRY_INVALID", "The exception expiry must be in the future.");
      }
      const payloadHash = hashPayload({
        applicationId: input.applicationId,
        proposedValue: input.proposedValue,
        policyValue: input.policyValue,
        reason,
        requiredApproverRole: input.requiredApproverRole,
        expiresAt: expiresAt?.toISOString() ?? null,
      });
      const scope = `application:${input.applicationId}:exception-request`;
      const existing = await financingRepo(options.database).findCommand(scope, input.idempotencyKey);
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw idempotencyConflict();
        const responseId = existing.response["exceptionId"];
        if (typeof responseId !== "string") throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved command response is invalid.");
        const replay = await financingRepo(options.database).findException(responseId);
        if (replay === null) throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved command response is missing.");
        return replay;
      }
      const exceptionId = randomUUID();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = financingRepo(tx);
          const application = await repo.lockApplication(input.applicationId);
          if (application === null) throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found.");
          if (application.status === "REJECTED" || application.status === "SETTLED") {
            throw new AppError(409, "EXCEPTION_APPLICATION_CLOSED", "This application cannot receive an exception.");
          }
          const created = await repo.insertException({
            id: exceptionId,
            applicationId: input.applicationId,
            proposedValue: input.proposedValue,
            policyValue: input.policyValue,
            reason,
            requestedBy: input.actor.staffUserId,
            requiredApproverRole: input.requiredApproverRole,
            ...(expiresAt === undefined ? {} : { expiresAt }),
          });
          const response = serializeException(created);
          await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "EXCEPTION_REQUEST",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            applicationId: input.applicationId,
            response,
          });
          await appendAuditEvent(tx, {
            aggregateType: "exception_request",
            aggregateId: created.id,
            action: "EXCEPTION_REQUESTED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              applicationId: input.applicationId,
              requiredApproverRole: input.requiredApproverRole,
              proposedValue: input.proposedValue,
              policyValue: input.policyValue,
            },
            occurredAt: new Date(),
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "financing.exception.requested",
            aggregateType: "exception_request",
            aggregateId: created.id,
            payload: response,
            occurredAt: new Date(),
          });
          return created;
        });
      } catch (error) {
        throw mapError(error, "EXCEPTION_REQUEST_FAILED");
      }
    },

    async decide(input) {
      assertStaffActor(input.actor);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new AppError(400, "VERSION_INVALID", "The exception version is invalid.");
      }
      const reason = normalizeReason(input.reason);
      const status = input.decision === "APPROVE" ? "APPROVED" : input.decision === "REJECT" ? "REJECTED" : null;
      if (status === null) throw new AppError(400, "DECISION_INVALID", "The exception decision is invalid.");
      const current = await financingRepo(options.database).findException(input.exceptionId);
      if (current === null) throw new AppError(404, "EXCEPTION_NOT_FOUND", "Exception not found.");
      if (!input.actor.roles.includes(current.requiredApproverRole as StaffRole)) {
        throw new AppError(403, "EXCEPTION_APPROVER_UNAUTHORIZED", "The required approving authority is not present.");
      }
      if (current.requestedBy === input.actor.staffUserId) {
        throw new AppError(403, "EXCEPTION_REQUESTER_CANNOT_APPROVE", "The requester cannot decide their own exception.");
      }
      const payloadHash = hashPayload({
        exceptionId: input.exceptionId,
        expectedVersion: input.expectedVersion,
        decision: input.decision,
        reason,
      });
      const scope = `exception:${input.exceptionId}:decision`;
      const existing = await financingRepo(options.database).findCommand(scope, input.idempotencyKey);
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw idempotencyConflict();
        const responseId = existing.response["exceptionId"];
        if (typeof responseId !== "string") throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved command response is invalid.");
        const replay = await financingRepo(options.database).findException(responseId);
        if (replay === null) throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved command response is missing.");
        return replay;
      }
      const now = new Date();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = financingRepo(tx);
          const decided = await repo.decideException({
            exceptionId: input.exceptionId,
            expectedVersion: input.expectedVersion,
            actorStaffUserId: input.actor.staffUserId,
            status,
            reason,
            now,
          });
          const response = serializeException(decided);
          await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "EXCEPTION_DECIDE",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            applicationId: decided.applicationId,
            response,
          });
          await appendAuditEvent(tx, {
            aggregateType: "exception_request",
            aggregateId: decided.id,
            action: status === "APPROVED" ? "EXCEPTION_APPROVED" : "EXCEPTION_REJECTED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { version: decided.version, reason },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "financing.exception.decided",
            aggregateType: "exception_request",
            aggregateId: decided.id,
            payload: response,
            occurredAt: now,
          });
          return decided;
        });
      } catch (error) {
        throw mapError(error, "EXCEPTION_DECISION_FAILED");
      }
    },

    async findApproved(applicationId, now = new Date()) {
      return financingRepo(options.database).findApprovedException(applicationId, now);
    },
  };
}

function assertStaffActor(actor: StaffPrincipal): void {
  if (actor.kind !== "staff" || actor.roles.includes("SYSTEM_ADMIN")) {
    throw new AppError(403, "FORBIDDEN", "The staff action is not permitted.");
  }
}

function assertRole(role: StaffRole): void {
  if (!approverRoles.includes(role)) {
    throw new AppError(400, "APPROVER_ROLE_INVALID", "The approving authority is invalid.");
  }
}

function normalizeReason(reason: string): string {
  const normalized = reason.trim();
  if (normalized.length < 1 || normalized.length > 4_000) {
    throw new AppError(400, "REASON_INVALID", "A reason is required.");
  }
  return normalized;
}

function parseDate(value: string, code: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(parsed.getTime())) {
    throw new AppError(400, code, "The date is invalid.");
  }
  return parsed;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function serializeException(exception: ExceptionRecord): Record<string, unknown> {
  return {
    exceptionId: exception.id,
    applicationId: exception.applicationId,
    status: exception.status,
    version: exception.version,
  };
}

function idempotencyConflict(): AppError {
  return new AppError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "The idempotency key was reused with a different command.");
}

function mapError(error: unknown, fallback: string): AppError | unknown {
  if (error instanceof AppError) return error;
  if (error instanceof Error && error.message === "EXCEPTION_DECISION_REJECTED") {
    return new AppError(409, "EXCEPTION_STALE_OR_EXPIRED", "The exception is stale, expired, or already decided.");
  }
  return error instanceof Error ? error : new Error(fallback);
}

