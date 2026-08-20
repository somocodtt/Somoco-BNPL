import { randomUUID } from "node:crypto";
import {
  approvalRepo,
  appendAuditEvent,
  enqueueOutbox,
  withTransaction,
  type Database,
} from "@somo/db";
import { AppError } from "../../plugins/errors.js";
import type {
  CustomerPrincipal,
  StaffPrincipal,
  StaffRole,
} from "../access/policy.js";
import {
  assertDecisionAllowed,
  nextStatusForApproval,
  reviewStatusForStage,
  stageForReviewStatus,
  stageRole,
  type ApprovalAction,
  type ApprovalStage,
  type DecisionActor,
  type TemporaryDelegation,
} from "./policy.js";
import {
  replayWorkflowCommand,
  workflowPayloadHash,
} from "./command-idempotency.js";

export interface ApprovalCommandInput {
  applicationId: string;
  expectedVersion: number;
  stage: ApprovalStage;
  actor: DecisionActor;
  note: string;
  requestId: string;
  idempotencyKey: string;
  delegation?: TemporaryDelegation;
}

export interface ApprovalResult {
  id: string;
  applicationId: string;
  stage: ApprovalStage;
  action: ApprovalAction;
  status: string;
  version: number;
}

export interface ResubmissionInput {
  applicationId: string;
  expectedVersion: number;
  actor:
    | CustomerPrincipal
    | { kind: "customer"; personId: string; sessionId: string };
  requestId: string;
  idempotencyKey: string;
}

export interface ResubmissionResult {
  id: string;
  applicationId: string;
  status: string;
  version: number;
  applicationVersion: number;
}

export interface ApprovalService {
  getQueue(input: { actor: StaffPrincipal }): Promise<
    Array<{
      id: string;
      status: string;
      version: number;
      submittedAt: string | null;
      snapshot: Record<string, unknown>;
    }>
  >;
  getApplication(input: {
    actor: StaffPrincipal;
    applicationId: string;
  }): Promise<Record<string, unknown>>;
  approve(input: ApprovalCommandInput): Promise<ApprovalResult>;
  reject(input: ApprovalCommandInput): Promise<ApprovalResult>;
  requestInformation(input: ApprovalCommandInput): Promise<ApprovalResult>;
  resubmit(input: ResubmissionInput): Promise<ResubmissionResult>;
}

export function createApprovalService(options: {
  database: Database;
  clock?: { now(): Date };
}): ApprovalService {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    async getQueue({ actor }) {
      if (actor.roles.includes("SYSTEM_ADMIN")) return [];
      const statuses = new Set<string>();
      for (const role of actor.roles) {
        if (role === "VERIFICATION_OFFICER")
          statuses.add("VERIFICATION_REVIEW");
        if (role === "BSM") {
          statuses.add("BSM_INITIAL_REVIEW");
          statuses.add("BSM_FINAL_REVIEW");
        }
        if (role === "AGM") statuses.add("AGM_REVIEW");
        if (role === "CFO") statuses.add("CFO_REVIEW");
        if (role === "MD") statuses.add("MD_REVIEW");
      }
      const records = await approvalRepo(options.database).listQueue([
        ...statuses,
      ]);
      return records.map((record) => ({
        ...record,
        submittedAt:
          record.submittedAt === null
            ? null
            : new Date(record.submittedAt).toISOString(),
      }));
    },

    async getApplication({ actor, applicationId }) {
      assertUuid(applicationId, "APPLICATION_ID_INVALID");
      if (actor.roles.includes("SYSTEM_ADMIN")) {
        throw new AppError(403, "FORBIDDEN", "Action is not permitted.");
      }
      const record = await approvalRepo(options.database).detail(applicationId);
      if (record === null) {
        throw new AppError(
          404,
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
        );
      }
      const currentStage =
        stageForReviewStatus(record.status) ?? record.informationRequestedStage;
      if (
        currentStage === null ||
        currentStage === undefined ||
        !actor.roles.includes(stageRole(currentStage as ApprovalStage))
      ) {
        throw new AppError(403, "FORBIDDEN", "Action is not permitted.");
      }
      return {
        ...record,
        submittedAt:
          record.submittedAt === null
            ? null
            : new Date(record.submittedAt).toISOString(),
      };
    },

    approve(input) {
      return decide(options.database, clock, input, "APPROVE");
    },
    reject(input) {
      return decide(options.database, clock, input, "REJECT");
    },
    requestInformation(input) {
      return decide(options.database, clock, input, "REQUEST_INFORMATION");
    },
    resubmit(input) {
      return resubmit(options.database, clock, input);
    },
  };
}

async function decide(
  database: Database,
  clock: { now(): Date },
  input: ApprovalCommandInput,
  action: ApprovalAction,
): Promise<ApprovalResult> {
  assertCommand(input);
  const note = normalizeNote(input.note);
  const payloadHash = workflowPayloadHash({
    applicationId: input.applicationId,
    expectedVersion: input.expectedVersion,
    stage: input.stage,
    action,
    note,
    actorStaffUserId: input.actor.staffUserId,
  });
  try {
    return await withTransaction(database, async (tx) => {
      const repo = approvalRepo(tx);
      const replay = replayWorkflowCommand<ApprovalResult>(
        await repo.findWorkflowCommand(
          input.applicationId,
          input.idempotencyKey,
        ),
        "APPROVAL",
        payloadHash,
      );
      if (replay !== null) return replay;
      const current = await repo.lockApplication(input.applicationId);
      if (current === null)
        throw new AppError(
          404,
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
        );
      assertExpectedVersion(current.version, input.expectedVersion);
      const currentStage = stageForReviewStatus(current.status);
      if (currentStage === null) {
        if (current.status === "REJECTED" || current.status === "APPROVED") {
          throw new AppError(
            409,
            "APPLICATION_TERMINAL",
            "The application can no longer be decided.",
          );
        }
        throw new AppError(
          409,
          "APPROVAL_STAGE_MISMATCH",
          "The application is not awaiting this stage.",
        );
      }
      if (currentStage !== input.stage) {
        throw new AppError(
          409,
          "APPROVAL_STAGE_MISMATCH",
          "The application is not awaiting this stage.",
        );
      }

      const exceptionRequestedBy = await repo.hasPendingExceptionRequestedBy(
        input.applicationId,
        input.actor.staffUserId,
      );
      const persistedDelegation = await repo.findActiveDelegation(
        input.actor.staffUserId,
        input.stage,
        clock.now(),
      );
      const delegation =
        persistedDelegation === null
          ? null
          : {
              delegateId: persistedDelegation.delegateId,
              role: persistedDelegation.role as StaffRole,
              scope: persistedDelegation.scope as ApprovalStage[],
              approvedBy: persistedDelegation.approvedBy,
              effectiveFrom: new Date(
                persistedDelegation.effectiveFrom,
              ).toISOString(),
              effectiveUntil: new Date(
                persistedDelegation.effectiveUntil,
              ).toISOString(),
              id: persistedDelegation.id,
            };
      try {
        assertDecisionAllowed(input.actor, input.stage, {
          ...(exceptionRequestedBy
            ? { exceptionRequestedBy: input.actor.staffUserId }
            : {}),
          ...(delegation === null ? {} : { delegation }),
          now: clock.now(),
        });
      } catch (error) {
        throw mapPolicyError(error);
      }

      const latest = await repo.latestVersion(input.applicationId);
      if (latest === null) throw new Error("APPLICATION_VERSION_MISSING");
      let decision;
      try {
        decision = await repo.insertDecision({
          applicationVersionId: latest.id,
          stage: input.stage,
          action,
          reason: note,
          decidedBy: input.actor.staffUserId,
          decidedAt: clock.now(),
        });
      } catch (error) {
        if (databaseErrorCode(error) === "23505") {
          throw new AppError(
            409,
            "DUPLICATE_DECISION",
            "This stage has already been decided.",
          );
        }
        throw error;
      }

      const nextStatus =
        action === "APPROVE"
          ? nextStatusForApproval(input.stage)
          : action === "REJECT"
            ? "REJECTED"
            : "INFORMATION_REQUESTED";
      const updated = await repo.updateApplication(
        input.applicationId,
        input.expectedVersion,
        nextStatus,
        clock.now(),
        action === "REQUEST_INFORMATION" ? input.stage : null,
      );
      const actorRole = actorRoleFor(input.actor, input.stage, delegation);
      const eventData = {
        decisionId: decision.id,
        actorStaffUserId: input.actor.staffUserId,
        role: actorRole,
        actorRole,
        stage: input.stage,
        note,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        expectedVersion: input.expectedVersion,
        outcome: action,
        status: updated.status,
        ...(delegation === null
          ? {}
          : {
              delegationId: delegation.id,
              delegationApprovedBy: delegation.approvedBy,
              delegationEffectiveFrom: new Date(
                delegation.effectiveFrom,
              ).toISOString(),
              delegationEffectiveUntil: new Date(
                delegation.effectiveUntil,
              ).toISOString(),
            }),
      };
      const response = {
        id: decision.id,
        applicationId: input.applicationId,
        stage: input.stage,
        action,
        status: updated.status,
        version: updated.version,
      } satisfies ApprovalResult;
      await repo.insertWorkflowCommand({
        applicationId: input.applicationId,
        idempotencyKey: input.idempotencyKey,
        commandType: "APPROVAL",
        payloadHash,
        requestId: input.requestId,
        actorStaffUserId: input.actor.staffUserId,
        response,
      });
      await appendAuditEvent(tx, {
        aggregateType: "application",
        aggregateId: input.applicationId,
        action: "APPLICATION_APPROVAL_DECIDED",
        actorStaffUserId: input.actor.staffUserId,
        requestId: input.requestId,
        data: eventData,
        occurredAt: clock.now(),
      });
      await enqueueOutbox(tx, {
        id: randomUUID(),
        topic: "applications.approval_decided",
        aggregateType: "application",
        aggregateId: input.applicationId,
        payload: eventData,
        occurredAt: clock.now(),
      });
      return response;
    });
  } catch (error) {
    if (databaseErrorCode(error) === "23505") {
      const replay = replayWorkflowCommand<ApprovalResult>(
        await approvalRepo(database).findWorkflowCommand(
          input.applicationId,
          input.idempotencyKey,
        ),
        "APPROVAL",
        payloadHash,
      );
      if (replay !== null) return replay;
    }
    throw mapServiceError(error);
  }
}

async function resubmit(
  database: Database,
  clock: { now(): Date },
  input: ResubmissionInput,
): Promise<ResubmissionResult> {
  assertUuid(input.applicationId, "APPLICATION_ID_INVALID");
  assertUuid(input.requestId, "REQUEST_ID_INVALID");
  assertUuid(input.idempotencyKey, "IDEMPOTENCY_KEY_INVALID");
  assertExpectedVersion(input.expectedVersion, input.expectedVersion);
  const payloadHash = workflowPayloadHash({
    applicationId: input.applicationId,
    expectedVersion: input.expectedVersion,
    actorPersonId: input.actor.personId,
  });
  try {
    return await withTransaction(database, async (tx) => {
      const repo = approvalRepo(tx);
      const replay = replayWorkflowCommand<ResubmissionResult>(
        await repo.findWorkflowCommand(
          input.applicationId,
          input.idempotencyKey,
        ),
        "RESUBMISSION",
        payloadHash,
      );
      if (replay !== null) return replay;
      const current = await repo.lockApplication(input.applicationId);
      if (current === null)
        throw new AppError(
          404,
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
        );
      assertExpectedVersion(current.version, input.expectedVersion);
      if (current.applicantPersonId !== input.actor.personId) {
        throw new AppError(
          404,
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
        );
      }
      if (current.status !== "INFORMATION_REQUESTED") {
        throw new AppError(
          409,
          "APPLICATION_STATE_INVALID",
          "The application is not awaiting resubmission.",
        );
      }
      const latest = await repo.latestVersion(input.applicationId);
      if (latest === null) throw new Error("APPLICATION_VERSION_MISSING");
      const requestedStage =
        current.informationRequestedStage ??
        (await repo.latestInformationRequestStage(input.applicationId));
      if (requestedStage === null) {
        throw new AppError(
          409,
          "APPLICATION_STATE_INVALID",
          "The application is missing its controlled review stage.",
        );
      }
      const now = clock.now();
      const snapshot = {
        ...latest.snapshot,
        resubmission: {
          requestedAt: now.toISOString(),
          requestId: input.requestId,
          idempotencyKey: input.idempotencyKey,
          priorVersion: latest.versionNumber,
          controlledStage: requestedStage,
        },
      };
      await repo.insertApplicationVersion({
        applicationId: input.applicationId,
        versionNumber: latest.versionNumber + 1,
        snapshot,
        submittedAt: now,
      });
      const updated = await repo.updateApplication(
        input.applicationId,
        input.expectedVersion,
        reviewStatusForStage(requestedStage as ApprovalStage),
        now,
        null,
      );
      const eventData = {
        actorPersonId: input.actor.personId,
        role: "APPLICANT",
        actorRole: "APPLICANT",
        stage: "CUSTOMER_RESUBMISSION",
        note: "Application resubmitted after requested information.",
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
        outcome: "RESUBMITTED",
        status: updated.status,
        version: updated.version,
      };
      const response = {
        id: updated.id,
        applicationId: input.applicationId,
        status: reviewStatusForStage(requestedStage as ApprovalStage),
        version: updated.version,
        applicationVersion: latest.versionNumber + 1,
      } satisfies ResubmissionResult;
      await repo.insertWorkflowCommand({
        applicationId: input.applicationId,
        idempotencyKey: input.idempotencyKey,
        commandType: "RESUBMISSION",
        payloadHash,
        requestId: input.requestId,
        actorPersonId: input.actor.personId,
        response,
      });
      await appendAuditEvent(tx, {
        aggregateType: "application",
        aggregateId: input.applicationId,
        action: "APPLICATION_RESUBMITTED",
        requestId: input.requestId,
        data: eventData,
        occurredAt: now,
      });
      await enqueueOutbox(tx, {
        id: randomUUID(),
        topic: "applications.resubmitted",
        aggregateType: "application",
        aggregateId: input.applicationId,
        payload: eventData,
        occurredAt: now,
      });
      return response;
    });
  } catch (error) {
    if (databaseErrorCode(error) === "23505") {
      const replay = replayWorkflowCommand<ResubmissionResult>(
        await approvalRepo(database).findWorkflowCommand(
          input.applicationId,
          input.idempotencyKey,
        ),
        "RESUBMISSION",
        payloadHash,
      );
      if (replay !== null) return replay;
    }
    throw mapServiceError(error);
  }
}

function actorRoleFor(
  actor: StaffPrincipal,
  stage: ApprovalStage,
  delegation: { role: string } | null,
): string {
  if (actor.roles.includes(stageRole(stage))) return stageRole(stage);
  return actor.roles[0] ?? delegation?.role ?? "UNKNOWN";
}

function assertCommand(input: ApprovalCommandInput): void {
  assertUuid(input.applicationId, "APPLICATION_ID_INVALID");
  assertUuid(input.requestId, "REQUEST_ID_INVALID");
  assertUuid(input.idempotencyKey, "IDEMPOTENCY_KEY_INVALID");
  assertExpectedVersion(input.expectedVersion, input.expectedVersion);
}

function assertExpectedVersion(actual: number, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new AppError(400, "VERSION_INVALID", "The saved version is invalid.");
  }
  if (actual !== expected) {
    throw new AppError(
      409,
      "STALE_VERSION",
      "The application changed before this decision was applied.",
    );
  }
}

function normalizeNote(value: string): string {
  const note = value.trim();
  if (note.length === 0 || note.length > 4_000) {
    throw new AppError(400, "NOTE_INVALID", "A decision note is required.");
  }
  return note;
}

function assertUuid(value: string, code: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new AppError(400, code, "The request identifier is invalid.");
  }
}

function mapPolicyError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  const code = error instanceof Error ? error.message : "FORBIDDEN";
  if (code === "EXCEPTION_REQUESTER_CANNOT_APPROVE") {
    return new AppError(
      403,
      code,
      "The requester cannot approve their own exception.",
    );
  }
  if (code === "DELEGATION_EXPIRED") {
    return new AppError(
      403,
      code,
      "The temporary delegation is no longer active.",
    );
  }
  return new AppError(403, "FORBIDDEN", "Action is not permitted.");
}

function mapServiceError(error: unknown): AppError | unknown {
  if (error instanceof AppError) return error;
  const code = error instanceof Error ? error.message : "UNKNOWN";
  const mapping: Record<string, [number, string]> = {
    APPLICATION_VERSION_MISSING: [
      409,
      "The submitted application snapshot is missing.",
    ],
    APPLICATION_VERSION_INSERT_FAILED: [
      409,
      "The application version could not be stored.",
    ],
    APPROVAL_DECISION_INSERT_FAILED: [
      409,
      "The approval decision could not be stored.",
    ],
    STALE_VERSION: [
      409,
      "The application changed before this decision was applied.",
    ],
  };
  const mapped = mapping[code];
  return mapped === undefined
    ? error
    : new AppError(mapped[0], code, mapped[1]);
}

function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current !== null; depth += 1) {
    if (typeof current !== "object") return undefined;
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}
