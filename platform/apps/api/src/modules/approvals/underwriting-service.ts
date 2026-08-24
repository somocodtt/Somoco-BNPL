import { randomUUID } from "node:crypto";
import {
  approvalRepo,
  appendAuditEvent,
  enqueueOutbox,
  withTransaction,
  type Database,
} from "@somo/db";
import { AppError } from "../../plugins/errors.js";
import type { StaffPrincipal } from "../access/policy.js";
import {
  replayWorkflowCommand,
  workflowPayloadHash,
} from "./command-idempotency.js";
import { assertDecisionAllowed } from "./policy.js";

export type ManualCreditBureauResult = "CLEAN" | "ADVERSE" | "REVIEW";

export interface ManualCreditBureauCheckInput {
  applicationId: string;
  expectedVersion: number;
  actor: StaffPrincipal;
  result: ManualCreditBureauResult;
  checkedAt: string;
  bureauReference: string;
  evidenceDocumentId: string;
  requestId: string;
  idempotencyKey: string;
}

export interface ManualCreditBureauCheckResult {
  applicationId: string;
  applicationVersionId: string;
  result: ManualCreditBureauResult;
  checkedAt: string;
  officer: string;
  bureauReference: string;
  evidenceDocumentId: string;
}

export interface UnderwritingService {
  recordManualCreditBureauCheck(
    input: ManualCreditBureauCheckInput,
  ): Promise<ManualCreditBureauCheckResult>;
}

export function createUnderwritingService(options: {
  database: Database;
  clock?: { now(): Date };
}): UnderwritingService {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    recordManualCreditBureauCheck(input) {
      return recordManualCreditBureauCheck(options.database, clock, input);
    },
  };
}

async function recordManualCreditBureauCheck(
  database: Database,
  clock: { now(): Date },
  input: ManualCreditBureauCheckInput,
): Promise<ManualCreditBureauCheckResult> {
  assertUuid(input.applicationId, "APPLICATION_ID_INVALID");
  assertUuid(input.requestId, "REQUEST_ID_INVALID");
  assertUuid(input.idempotencyKey, "IDEMPOTENCY_KEY_INVALID");
  assertUuid(input.evidenceDocumentId, "EVIDENCE_DOCUMENT_ID_INVALID");
  const manualResults: readonly ManualCreditBureauResult[] = [
    "CLEAN",
    "ADVERSE",
    "REVIEW",
  ];
  if (!manualResults.includes(input.result)) {
    throw new AppError(
      400,
      "BUREAU_RESULT_INVALID",
      "The manual bureau result is invalid.",
    );
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{1,127}$/.test(input.bureauReference)) {
    throw new AppError(
      400,
      "BUREAU_REFERENCE_INVALID",
      "The bureau reference is invalid.",
    );
  }
  const checkedAt = new Date(input.checkedAt);
  if (!Number.isFinite(checkedAt.getTime())) {
    throw new AppError(
      400,
      "CHECK_DATE_INVALID",
      "The bureau check date is invalid.",
    );
  }
  const payloadHash = workflowPayloadHash({
    applicationId: input.applicationId,
    expectedVersion: input.expectedVersion,
    actorStaffUserId: input.actor.staffUserId,
    result: input.result,
    checkedAt: checkedAt.toISOString(),
    bureauReference: input.bureauReference,
    evidenceDocumentId: input.evidenceDocumentId,
  });

  try {
    return await withTransaction(database, async (tx) => {
      const repo = approvalRepo(tx);
      const replay = replayWorkflowCommand<ManualCreditBureauCheckResult>(
        await repo.findWorkflowCommand(
          input.applicationId,
          input.idempotencyKey,
        ),
        "MANUAL_CREDIT_BUREAU",
        payloadHash,
      );
      if (replay !== null) return replay;
      const current = await repo.lockApplication(input.applicationId);
      if (current === null) {
        throw new AppError(
          404,
          "APPLICATION_NOT_FOUND",
          "Application was not found.",
        );
      }
      if (current.version !== input.expectedVersion) {
        throw new AppError(
          409,
          "STALE_VERSION",
          "The application changed before the check was recorded.",
        );
      }
      if (current.status !== "VERIFICATION_REVIEW") {
        throw new AppError(
          409,
          "APPLICATION_STATE_INVALID",
          "A bureau check is only recorded during verification.",
        );
      }
      try {
        assertDecisionAllowed(input.actor, "VERIFICATION");
      } catch {
        throw new AppError(
          403,
          "FORBIDDEN",
          "Only verification staff can record bureau evidence.",
        );
      }

      if (
        !(await repo.evidenceDocumentBelongsToApplication(
          input.applicationId,
          input.evidenceDocumentId,
        ))
      ) {
        throw new AppError(
          409,
          "BUREAU_EVIDENCE_INVALID",
          "The clean bureau evidence document is not available.",
        );
      }
      const latest = await repo.latestVersion(input.applicationId);
      if (latest === null) throw new Error("APPLICATION_VERSION_MISSING");
      const now = clock.now();
      const assessment = {
        kind: "MANUAL_CREDIT_BUREAU_CHECK",
        result: input.result,
        checkedAt: checkedAt.toISOString(),
        officer: input.actor.staffUserId,
        bureauReference: input.bureauReference,
        evidenceDocumentId: input.evidenceDocumentId,
        requestId: input.requestId,
        idempotencyKey: input.idempotencyKey,
      } satisfies Record<string, unknown>;
      await repo.insertUnderwritingAssessment({
        applicationVersionId: latest.id,
        assessment,
        assessedBy: input.actor.staffUserId,
        assessedAt: now,
      });
      await appendAuditEvent(tx, {
        aggregateType: "application",
        aggregateId: input.applicationId,
        action: "MANUAL_CREDIT_BUREAU_CHECK_RECORDED",
        actorStaffUserId: input.actor.staffUserId,
        requestId: input.requestId,
        data: {
          ...assessment,
          role: "VERIFICATION_OFFICER",
          actorRole: "VERIFICATION_OFFICER",
          stage: "VERIFICATION",
          outcome: "RECORDED",
        },
        occurredAt: now,
      });
      await enqueueOutbox(tx, {
        id: randomUUID(),
        topic: "applications.credit_bureau_checked",
        aggregateType: "application",
        aggregateId: input.applicationId,
        payload: assessment,
        occurredAt: now,
      });
      const response = {
        applicationId: input.applicationId,
        applicationVersionId: latest.id,
        result: input.result,
        checkedAt: checkedAt.toISOString(),
        officer: input.actor.staffUserId,
        bureauReference: input.bureauReference,
        evidenceDocumentId: input.evidenceDocumentId,
      };
      await repo.insertWorkflowCommand({
        applicationId: input.applicationId,
        idempotencyKey: input.idempotencyKey,
        commandType: "MANUAL_CREDIT_BUREAU",
        payloadHash,
        requestId: input.requestId,
        actorStaffUserId: input.actor.staffUserId,
        response,
      });
      return response;
    });
  } catch (error) {
    if (databaseErrorCode(error) === "23505") {
      const replay = replayWorkflowCommand<ManualCreditBureauCheckResult>(
        await approvalRepo(database).findWorkflowCommand(
          input.applicationId,
          input.idempotencyKey,
        ),
        "MANUAL_CREDIT_BUREAU",
        payloadHash,
      );
      if (replay !== null) return replay;
    }
    if (error instanceof AppError) throw error;
    if (
      error instanceof Error &&
      error.message === "APPLICATION_VERSION_MISSING"
    ) {
      throw new AppError(
        409,
        error.message,
        "The submitted application snapshot is missing.",
      );
    }
    throw error;
  }
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

function assertUuid(value: string, code: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new AppError(400, code, "The request identifier is invalid.");
  }
}
