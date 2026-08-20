import { createHash } from "node:crypto";
import type { WorkflowCommandRecord } from "@somo/db";
import { AppError } from "../../plugins/errors.js";

export type WorkflowCommandType =
  "APPROVAL" | "RESUBMISSION" | "MANUAL_CREDIT_BUREAU";

export function workflowPayloadHash(payload: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export function replayWorkflowCommand<T>(
  command: WorkflowCommandRecord | null,
  commandType: WorkflowCommandType,
  payloadHash: string,
): T | null {
  if (command === null) return null;
  if (
    command.commandType !== commandType ||
    command.payloadHash !== payloadHash
  ) {
    throw new AppError(
      409,
      "IDEMPOTENCY_KEY_REUSE",
      "The idempotency key was already used for a different command.",
    );
  }
  return command.response as T;
}
