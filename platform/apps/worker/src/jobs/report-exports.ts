import {
  appendReportExportReadyEvent,
  type Database,
  type OutboxMessage,
} from "@somo/db";
import {
  createOutboxHandler,
  PermanentWorkerError,
  type OutboxHandler,
} from "./dispatch-outbox.js";

export interface ReportExportCompletionPort {
  complete(input: {
    exportId: string;
    eventKey: string;
    contentHash: string;
    artifact: Record<string, unknown>;
  }): Promise<boolean>;
}

export function createDatabaseReportExportCompletionPort(
  database: Database,
): ReportExportCompletionPort {
  return {
    complete: (input) => appendReportExportReadyEvent(database, input),
  };
}

export function createReportExportHandler(
  port: ReportExportCompletionPort,
): OutboxHandler {
  return createOutboxHandler([], async (message: OutboxMessage) => {
    const payload = reportExportPayload(message.payload);
    const contentHash = sha256(payload.content);
    if (contentHash !== payload.expectedContentHash)
      throw new PermanentWorkerError("REPORT_EXPORT_CONTENT_HASH_MISMATCH");
    await port.complete({
      exportId: payload.exportId,
      eventKey: `report-export:${payload.exportId}:READY`,
      contentHash,
      artifact: {
        content: payload.content,
        contentHash,
        format: payload.format,
        watermark: payload.watermark,
        noRawDocumentUrls: true,
        workerOutboxMessageId: message.id,
      },
    });
    return { exportId: payload.exportId, status: "READY" };
  });
}

function reportExportPayload(payload: unknown): {
  exportId: string;
  content: string;
  expectedContentHash: string;
  format: "CSV" | "JSON";
  watermark: string;
} {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new PermanentWorkerError("REPORT_EXPORT_PAYLOAD_INVALID");
  const value = payload as Record<string, unknown>;
  if (
    typeof value.exportId !== "string" ||
    typeof value.content !== "string" ||
    typeof value.expectedContentHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.expectedContentHash) ||
    (value.format !== "CSV" && value.format !== "JSON") ||
    typeof value.watermark !== "string"
  )
    throw new PermanentWorkerError("REPORT_EXPORT_PAYLOAD_INVALID");
  return {
    exportId: value.exportId,
    content: value.content,
    expectedContentHash: value.expectedContentHash,
    format: value.format,
    watermark: value.watermark,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
import { createHash } from "node:crypto";
