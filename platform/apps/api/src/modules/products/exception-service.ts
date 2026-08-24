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
import { canonicalizeJson } from "@somo/domain/src/index.js";

const approverRoles: readonly StaffRole[] = [
  "PRODUCT_ADMIN",
  "BSM",
  "AGM",
  "CFO",
  "MD",
  "COMPLIANCE_OFFICER",
];

type ExceptionRequestBase = {
  applicationId: string;
  ruleVersionId: string;
  reason: string;
  requiredApproverRole: StaffRole;
  expiresAt?: string;
  idempotencyKey: string;
  actor: StaffPrincipal;
  requestId: string;
};

export type ExceptionRequestInput =
  | (ExceptionRequestBase & {
      valueType: "AMOUNT";
      exceptionField: "minimumDepositMinor";
      proposedValue: { minimumDepositMinor: string | bigint };
      policyValue: { minimumDepositMinor: string | bigint };
      proposedAmountMinor: string | bigint;
      policyAmountMinor: string | bigint;
      proposedFrequency?: never;
      policyFrequency?: never;
      proposedTenureMonths?: never;
      policyTenureMonths?: never;
    })
  | (ExceptionRequestBase & {
      valueType: "FREQUENCY";
      exceptionField: "repaymentFrequency";
      proposedValue: { repaymentFrequency: "WEEKLY" | "MONTHLY" };
      policyValue: { repaymentFrequency: "WEEKLY" | "MONTHLY" };
      proposedFrequency: "WEEKLY" | "MONTHLY";
      policyFrequency: "WEEKLY" | "MONTHLY";
      proposedAmountMinor?: never;
      policyAmountMinor?: never;
      proposedTenureMonths?: never;
      policyTenureMonths?: never;
    })
  | (ExceptionRequestBase & {
      valueType: "TENURE";
      exceptionField: "tenureMonths";
      proposedValue: { tenureMonths: number };
      policyValue: { tenureMonths: number };
      proposedTenureMonths: number;
      policyTenureMonths: number;
      proposedAmountMinor?: never;
      policyAmountMinor?: never;
      proposedFrequency?: never;
      policyFrequency?: never;
    });

export interface ExceptionService {
  request(input: ExceptionRequestInput): Promise<ExceptionRecord>;
  decide(input: {
    exceptionId: string;
    expectedVersion: number;
    decision: "APPROVE" | "REJECT";
    reason: string;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<ExceptionRecord>;
  findApproved(
    applicationId: string,
    now?: Date,
    binding?: {
      ruleVersionId?: string;
      field?: string;
      valueType?: "AMOUNT" | "FREQUENCY" | "TENURE";
      proposedAmountMinor?: bigint;
      policyAmountMinor?: bigint;
      proposedFrequency?: string;
      policyFrequency?: string;
      proposedTenureMonths?: number;
      policyTenureMonths?: number;
    },
  ): Promise<ExceptionRecord | null>;
  list(): Promise<ExceptionRecord[]>;
  find(exceptionId: string): Promise<ExceptionRecord | null>;
}

export function createExceptionService(options: {
  database: Database;
}): ExceptionService {
  return {
    async request(input) {
      assertStaffActor(input.actor);
      assertRole(input.requiredApproverRole);
      const reason = normalizeReason(input.reason);
      const binding = normalizeBinding(input);
      const expiresAt =
        input.expiresAt === undefined
          ? undefined
          : parseDate(input.expiresAt, "EXCEPTION_EXPIRY_INVALID");
      if (expiresAt !== undefined && expiresAt <= new Date()) {
        throw new AppError(
          400,
          "EXCEPTION_EXPIRY_INVALID",
          "The exception expiry must be in the future.",
        );
      }
      const payloadHash = hashPayload({
        applicationId: input.applicationId,
        proposedValue: binding.proposedValue,
        policyValue: binding.policyValue,
        reason,
        requiredApproverRole: input.requiredApproverRole,
        ruleVersionId: input.ruleVersionId,
        exceptionField: binding.exceptionField,
        valueType: binding.valueType,
        proposedAmountMinor: binding.proposedAmountMinor?.toString() ?? null,
        policyAmountMinor: binding.policyAmountMinor?.toString() ?? null,
        proposedFrequency: binding.proposedFrequency ?? null,
        policyFrequency: binding.policyFrequency ?? null,
        proposedTenureMonths: binding.proposedTenureMonths ?? null,
        policyTenureMonths: binding.policyTenureMonths ?? null,
        expiresAt: expiresAt?.toISOString() ?? null,
      });
      const scope = `application:${input.applicationId}:exception-request`;
      const existing = await financingRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw idempotencyConflict();
        if (existing.actorStaffUserId !== input.actor.staffUserId)
          throw idempotencyActorConflict();
        const responseId = existing.response["exceptionId"];
        if (typeof responseId !== "string")
          throw new AppError(
            409,
            "IDEMPOTENCY_REPLAY_INVALID",
            "The saved command response is invalid.",
          );
        const replay = await financingRepo(options.database).findException(
          responseId,
        );
        if (replay === null)
          throw new AppError(
            409,
            "IDEMPOTENCY_REPLAY_INVALID",
            "The saved command response is missing.",
          );
        return replay;
      }
      const exceptionId = randomUUID();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = financingRepo(tx);
          const application = await repo.lockApplication(input.applicationId);
          if (application === null)
            throw new AppError(
              404,
              "APPLICATION_NOT_FOUND",
              "Application not found.",
            );
          if (
            application.status === "REJECTED" ||
            application.status === "SETTLED"
          ) {
            throw new AppError(
              409,
              "EXCEPTION_APPLICATION_CLOSED",
              "This application cannot receive an exception.",
            );
          }
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "EXCEPTION_REQUEST",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            applicationId: input.applicationId,
            response: {},
          });
          if (!command.inserted) {
            if (command.payloadHash !== payloadHash)
              throw idempotencyConflict();
            if (command.actorStaffUserId !== input.actor.staffUserId)
              throw idempotencyActorConflict();
            return replayException(options.database, command.response);
          }
          const created = await repo.insertException({
            id: exceptionId,
            applicationId: input.applicationId,
            proposedValue: binding.proposedValue,
            policyValue: binding.policyValue,
            reason,
            requestedBy: input.actor.staffUserId,
            requiredApproverRole: input.requiredApproverRole,
            ruleVersionId: input.ruleVersionId,
            exceptionField: binding.exceptionField,
            valueType: binding.valueType,
            ...(binding.proposedAmountMinor === undefined
              ? {}
              : { proposedAmountMinor: binding.proposedAmountMinor }),
            ...(binding.policyAmountMinor === undefined
              ? {}
              : { policyAmountMinor: binding.policyAmountMinor }),
            ...(binding.proposedFrequency === undefined
              ? {}
              : { proposedFrequency: binding.proposedFrequency }),
            ...(binding.policyFrequency === undefined
              ? {}
              : { policyFrequency: binding.policyFrequency }),
            ...(binding.proposedTenureMonths === undefined
              ? {}
              : { proposedTenureMonths: binding.proposedTenureMonths }),
            ...(binding.policyTenureMonths === undefined
              ? {}
              : { policyTenureMonths: binding.policyTenureMonths }),
            ...(expiresAt === undefined ? {} : { expiresAt }),
          });
          const response = serializeException(created);
          await repo.updateCommandResponse(
            scope,
            input.idempotencyKey,
            response,
          );
          await appendAuditEvent(tx, {
            aggregateType: "exception_request",
            aggregateId: created.id,
            action: "EXCEPTION_REQUESTED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              applicationId: input.applicationId,
              requiredApproverRole: input.requiredApproverRole,
              proposedValue: binding.proposedValue,
              policyValue: binding.policyValue,
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
        const raced = await financingRepo(options.database).findCommand(
          scope,
          input.idempotencyKey,
        );
        if (
          raced !== null &&
          raced.payloadHash === payloadHash &&
          raced.actorStaffUserId === input.actor.staffUserId
        ) {
          return replayException(options.database, raced.response);
        }
        throw mapError(error, "EXCEPTION_REQUEST_FAILED");
      }
    },

    async decide(input) {
      assertStaffActor(input.actor);
      if (
        !Number.isSafeInteger(input.expectedVersion) ||
        input.expectedVersion < 1
      ) {
        throw new AppError(
          400,
          "VERSION_INVALID",
          "The exception version is invalid.",
        );
      }
      const reason = normalizeReason(input.reason);
      const status =
        input.decision === "APPROVE"
          ? "APPROVED"
          : input.decision === "REJECT"
            ? "REJECTED"
            : null;
      if (status === null)
        throw new AppError(
          400,
          "DECISION_INVALID",
          "The exception decision is invalid.",
        );
      const current = await financingRepo(options.database).findException(
        input.exceptionId,
      );
      if (current === null)
        throw new AppError(404, "EXCEPTION_NOT_FOUND", "Exception not found.");
      if (
        !input.actor.roles.includes(current.requiredApproverRole as StaffRole)
      ) {
        throw new AppError(
          403,
          "EXCEPTION_APPROVER_UNAUTHORIZED",
          "The required approving authority is not present.",
        );
      }
      if (current.requestedBy === input.actor.staffUserId) {
        throw new AppError(
          403,
          "EXCEPTION_REQUESTER_CANNOT_APPROVE",
          "The requester cannot decide their own exception.",
        );
      }
      const payloadHash = hashPayload({
        exceptionId: input.exceptionId,
        expectedVersion: input.expectedVersion,
        decision: input.decision,
        reason,
      });
      const scope = `exception:${input.exceptionId}:decision`;
      const existing = await financingRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw idempotencyConflict();
        if (existing.actorStaffUserId !== input.actor.staffUserId)
          throw idempotencyActorConflict();
        const responseId = existing.response["exceptionId"];
        if (typeof responseId !== "string")
          throw new AppError(
            409,
            "IDEMPOTENCY_REPLAY_INVALID",
            "The saved command response is invalid.",
          );
        const replay = await financingRepo(options.database).findException(
          responseId,
        );
        if (replay === null)
          throw new AppError(
            409,
            "IDEMPOTENCY_REPLAY_INVALID",
            "The saved command response is missing.",
          );
        return replay;
      }
      const now = new Date();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = financingRepo(tx);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "EXCEPTION_DECIDE",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            response: {},
          });
          if (!command.inserted) {
            if (command.payloadHash !== payloadHash)
              throw idempotencyConflict();
            if (command.actorStaffUserId !== input.actor.staffUserId)
              throw idempotencyActorConflict();
            return replayException(options.database, command.response);
          }
          const decided = await repo.decideException({
            exceptionId: input.exceptionId,
            expectedVersion: input.expectedVersion,
            actorStaffUserId: input.actor.staffUserId,
            status,
            reason,
            now,
          });
          const response = serializeException(decided);
          await repo.updateCommandResponse(
            scope,
            input.idempotencyKey,
            response,
          );
          await appendAuditEvent(tx, {
            aggregateType: "exception_request",
            aggregateId: decided.id,
            action:
              status === "APPROVED"
                ? "EXCEPTION_APPROVED"
                : "EXCEPTION_REJECTED",
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
        const raced = await financingRepo(options.database).findCommand(
          scope,
          input.idempotencyKey,
        );
        if (
          raced !== null &&
          raced.payloadHash === payloadHash &&
          raced.actorStaffUserId === input.actor.staffUserId
        ) {
          return replayException(options.database, raced.response);
        }
        throw mapError(error, "EXCEPTION_DECISION_FAILED");
      }
    },

    async findApproved(applicationId, now = new Date(), binding) {
      return financingRepo(options.database).findApprovedException(
        applicationId,
        now,
        binding,
      );
    },

    async list() {
      return financingRepo(options.database).listExceptions();
    },

    async find(exceptionId) {
      return financingRepo(options.database).findException(exceptionId);
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
    throw new AppError(
      400,
      "APPROVER_ROLE_INVALID",
      "The approving authority is invalid.",
    );
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
  if (
    !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
    !Number.isFinite(parsed.getTime())
  ) {
    throw new AppError(400, code, "The date is invalid.");
  }
  return parsed;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

type NormalizedBinding = {
  exceptionField: string;
  valueType: "AMOUNT" | "FREQUENCY" | "TENURE";
  proposedValue: Record<string, string | number>;
  policyValue: Record<string, string | number>;
  proposedAmountMinor?: bigint;
  policyAmountMinor?: bigint;
  proposedFrequency?: "WEEKLY" | "MONTHLY";
  policyFrequency?: "WEEKLY" | "MONTHLY";
  proposedTenureMonths?: number;
  policyTenureMonths?: number;
};

function normalizeBinding(input: ExceptionRequestInput): NormalizedBinding {
  if (!/^[0-9a-f-]{36}$/i.test(input.ruleVersionId)) {
    throw new AppError(
      400,
      "EXCEPTION_BINDING_REQUIRED",
      "An exception must bind a rule version and field.",
    );
  }
  if (input.valueType === "AMOUNT") {
    const proposedAmountMinor = parseMinor(input.proposedAmountMinor);
    const policyAmountMinor = parseMinor(input.policyAmountMinor);
    const proposedValue = {
      minimumDepositMinor: proposedAmountMinor.toString(),
    };
    const policyValue = { minimumDepositMinor: policyAmountMinor.toString() };
    if (
      input.exceptionField !== "minimumDepositMinor" ||
      !sameValue(input.proposedValue, proposedValue) ||
      !sameValue(input.policyValue, policyValue) ||
      "proposedFrequency" in input ||
      "policyFrequency" in input ||
      "proposedTenureMonths" in input ||
      "policyTenureMonths" in input
    ) {
      throw new AppError(
        400,
        "EXCEPTION_BINDING_INVALID",
        "The amount exception contains an irrelevant or mismatched value.",
      );
    }
    return {
      exceptionField: input.exceptionField,
      valueType: input.valueType,
      proposedValue,
      policyValue,
      proposedAmountMinor,
      policyAmountMinor,
    };
  }
  if (input.valueType === "FREQUENCY") {
    if (
      input.exceptionField !== "repaymentFrequency" ||
      !sameFrequency(input.proposedFrequency) ||
      !sameFrequency(input.policyFrequency) ||
      !sameValue(input.proposedValue, {
        repaymentFrequency: input.proposedFrequency,
      }) ||
      !sameValue(input.policyValue, {
        repaymentFrequency: input.policyFrequency,
      }) ||
      "proposedAmountMinor" in input ||
      "policyAmountMinor" in input ||
      "proposedTenureMonths" in input ||
      "policyTenureMonths" in input
    ) {
      throw new AppError(
        400,
        "EXCEPTION_BINDING_INVALID",
        "The frequency exception contains an irrelevant or mismatched value.",
      );
    }
    return {
      exceptionField: input.exceptionField,
      valueType: input.valueType,
      proposedValue: { repaymentFrequency: input.proposedFrequency },
      policyValue: { repaymentFrequency: input.policyFrequency },
      proposedFrequency: input.proposedFrequency,
      policyFrequency: input.policyFrequency,
    };
  }
  if (
    input.valueType !== "TENURE" ||
    input.exceptionField !== "tenureMonths" ||
    !Number.isSafeInteger(input.proposedTenureMonths) ||
    !Number.isSafeInteger(input.policyTenureMonths) ||
    !sameValue(input.proposedValue, {
      tenureMonths: input.proposedTenureMonths,
    }) ||
    !sameValue(input.policyValue, { tenureMonths: input.policyTenureMonths }) ||
    "proposedAmountMinor" in input ||
    "policyAmountMinor" in input ||
    "proposedFrequency" in input ||
    "policyFrequency" in input
  ) {
    throw new AppError(
      400,
      "EXCEPTION_BINDING_INVALID",
      "The tenure exception contains an irrelevant or mismatched value.",
    );
  }
  return {
    exceptionField: input.exceptionField,
    valueType: input.valueType,
    proposedValue: { tenureMonths: input.proposedTenureMonths },
    policyValue: { tenureMonths: input.policyTenureMonths },
    proposedTenureMonths: input.proposedTenureMonths,
    policyTenureMonths: input.policyTenureMonths,
  };
}

function sameFrequency(value: unknown): value is "WEEKLY" | "MONTHLY" {
  return value === "WEEKLY" || value === "MONTHLY";
}

function sameValue(
  value: unknown,
  normalized: Record<string, string | number>,
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  try {
    return canonicalizeJson(value) === canonicalizeJson(normalized);
  } catch {
    return false;
  }
}

function parseMinor(value: string | bigint): bigint {
  const parsed =
    typeof value === "bigint"
      ? value
      : /^\d+$/.test(value)
        ? BigInt(value)
        : -1n;
  if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) {
    throw new AppError(
      400,
      "EXCEPTION_AMOUNT_INVALID",
      "The exception amount is invalid.",
    );
  }
  return parsed;
}

function serializeException(
  exception: ExceptionRecord,
): Record<string, unknown> {
  return {
    exceptionId: exception.id,
    applicationId: exception.applicationId,
    status: exception.status,
    version: exception.version,
  };
}

async function replayException(
  database: Database,
  response: Record<string, unknown>,
): Promise<ExceptionRecord> {
  const exceptionId = response["exceptionId"];
  if (typeof exceptionId !== "string") {
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved command response is invalid.",
    );
  }
  const exception = await financingRepo(database).findException(exceptionId);
  if (exception === null) {
    throw new AppError(
      409,
      "IDEMPOTENCY_REPLAY_INVALID",
      "The saved exception is missing.",
    );
  }
  return exception;
}

function idempotencyConflict(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_PAYLOAD_MISMATCH",
    "The idempotency key was reused with a different command.",
  );
}

function idempotencyActorConflict(): AppError {
  return new AppError(
    409,
    "IDEMPOTENCY_ACTOR_MISMATCH",
    "The idempotency key belongs to a different actor.",
  );
}

function mapError(error: unknown, fallback: string): AppError | unknown {
  if (error instanceof AppError) return error;
  if (
    error instanceof Error &&
    error.message === "EXCEPTION_DECISION_REJECTED"
  ) {
    return new AppError(
      409,
      "EXCEPTION_STALE_OR_EXPIRED",
      "The exception is stale, expired, or already decided.",
    );
  }
  return error instanceof Error ? error : new Error(fallback);
}
