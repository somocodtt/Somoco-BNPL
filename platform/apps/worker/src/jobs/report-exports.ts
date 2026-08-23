import { createHash } from "node:crypto";
import { sql } from "../../../../packages/db/node_modules/drizzle-orm/index.js";
import {
  appendReportExportFailedEvent,
  appendReportExportReadyEvent,
  type Database,
  type OutboxMessage,
} from "@somo/db";
import {
  readCanonicalReportPage,
  sanitizeReportFilters,
} from "../../../api/src/modules/reports/service.js";
import { getInternalDatabase } from "../../../../packages/db/src/client.js";
import {
  createOutboxHandler,
  PermanentWorkerError,
  type OutboxHandler,
} from "./dispatch-outbox.js";

export type ReportName = "operations" | "portfolio" | "audit" | "migration";
export type ReportFormat = "CSV" | "JSON";
export type ReportClassification = "REDACTED" | "PERSONAL_DATA";

export interface ReportExportJob {
  exportId: string;
  requesterStaffUserId: string;
  requestId: string;
  report: ReportName;
  format: ReportFormat;
  dataClassification: ReportClassification;
  filters: Record<string, unknown>;
  filtersFingerprint: string;
  expectedRowCount: number;
  watermark: string;
  status: "QUEUED" | "READY" | "FAILED";
}

export interface ReportExportPage {
  rows: readonly Record<string, unknown>[];
}

export interface ReportExportCompletionPort {
  load(exportId: string): Promise<ReportExportJob | null>;
  generate(job: ReportExportJob): AsyncIterable<ReportExportPage>;
  complete(input: {
    exportId: string;
    eventKey: string;
    contentHash: string;
    rowCount: number;
    artifact: Record<string, unknown>;
  }): Promise<boolean>;
  fail(input: {
    exportId: string;
    eventKey: string;
    reasonCode: string;
    artifact: Record<string, unknown>;
  }): Promise<boolean>;
}

export function createDatabaseReportExportCompletionPort(
  database: Database,
): ReportExportCompletionPort {
  const internal = getInternalDatabase(database);
  return {
    async load(exportId) {
      const result = await internal.execute<{
        id: string;
        requester_staff_user_id: string;
        request_id: string;
        report_type: string;
        format: ReportFormat;
        data_classification: ReportClassification;
        row_count: number;
        filters: Record<string, unknown>;
        artifact: Record<string, unknown>;
        status: "QUEUED" | "READY" | "FAILED";
      }>(sql`
        select e.id, e.requester_staff_user_id, e.request_id, e.report_type,
               e.format, e.data_classification, e.row_count, e.filters,
               e.artifact, e.status
          from report_export e
         where e.id = ${exportId}
         limit 1
      `);
      const row = result.rows[0];
      if (row === undefined) return null;
      const event = await internal.execute<{
        event_type: "QUEUED" | "READY" | "FAILED";
        artifact: Record<string, unknown>;
      }>(sql`
        select event_type, artifact
          from report_export_event
         where report_export_id = ${exportId}
         order by created_at desc, id desc
         limit 1
      `);
      const artifact = event.rows[0]?.artifact ?? row.artifact;
      const filtersFingerprint =
        typeof artifact.filtersFingerprint === "string"
          ? artifact.filtersFingerprint
          : sha256(canonicalJson(row.filters));
      return {
        exportId: row.id,
        requesterStaffUserId: row.requester_staff_user_id,
        requestId: row.request_id,
        report: row.report_type.toLowerCase() as ReportName,
        format: row.format,
        dataClassification: row.data_classification,
        filters: row.filters,
        filtersFingerprint,
        expectedRowCount: row.row_count,
        watermark: String(artifact.watermark ?? ""),
        status: event.rows[0]?.event_type ?? row.status,
      };
    },
    generate: (job) => databaseReportPages(database, job),
    complete: (input) => appendReportExportReadyEvent(database, input),
    fail: (input) => appendReportExportFailedEvent(database, input),
  };
}

export function createReportExportHandler(
  port: ReportExportCompletionPort,
): OutboxHandler {
  return createOutboxHandler([], async (message: OutboxMessage) => {
    if (typeof message.aggregateId !== "string" || message.aggregateId === "")
      throw new PermanentWorkerError("REPORT_EXPORT_AGGREGATE_MISMATCH");
    const job = await port.load(message.aggregateId);
    if (job === null) throw new PermanentWorkerError("REPORT_EXPORT_NOT_FOUND");
    if (job.status !== "QUEUED")
      return { exportId: job.exportId, status: job.status };
    try {
      const payload = reportExportPayload(message.payload);
      if (
        message.aggregateType !== "report_export" ||
        message.aggregateId !== payload.exportId ||
        job.exportId !== message.aggregateId
      )
        throw new PermanentWorkerError("REPORT_EXPORT_AGGREGATE_MISMATCH");
      if (
        job.requesterStaffUserId !== payload.requesterStaffUserId ||
        job.requestId !== payload.requestId ||
        job.report !== payload.report ||
        job.format !== payload.format ||
        job.dataClassification !== payload.dataClassification ||
        job.filtersFingerprint !== payload.filtersFingerprint ||
        job.expectedRowCount !== payload.expectedRowCount ||
        canonicalJson(job.filters) !== canonicalJson(payload.filters) ||
        payload.version !== 1
      )
        throw new PermanentWorkerError("REPORT_EXPORT_REQUEST_MISMATCH");
      try {
        const persistedFilters = sanitizeReportFilters(job.report, job.filters);
        const payloadFilters = sanitizeReportFilters(
          payload.report,
          payload.filters,
        );
        if (canonicalJson(persistedFilters) !== canonicalJson(payloadFilters))
          throw new PermanentWorkerError("REPORT_EXPORT_FILTER_MISMATCH");
      } catch (error) {
        if (error instanceof PermanentWorkerError) throw error;
        throw new PermanentWorkerError("REPORT_EXPORT_FILTER_INVALID");
      }
      const rows: Record<string, unknown>[] = [];
      for await (const page of port.generate(job)) {
        if (!Array.isArray(page.rows))
          throw new PermanentWorkerError("REPORT_EXPORT_PAGE_INVALID");
        for (const row of page.rows) {
          if (typeof row !== "object" || row === null || Array.isArray(row))
            throw new PermanentWorkerError("REPORT_EXPORT_ROW_INVALID");
          rows.push(row as Record<string, unknown>);
        }
      }
      if (rows.length !== job.expectedRowCount)
        throw new PermanentWorkerError("REPORT_EXPORT_ROW_COUNT_MISMATCH");
      const content = renderExport(job, rows);
      const contentHash = sha256(content);
      await port.complete({
        exportId: job.exportId,
        eventKey: `report-export:${job.exportId}:READY`,
        contentHash,
        rowCount: rows.length,
        artifact: {
          content,
          contentHash,
          rowCount: rows.length,
          requesterStaffUserId: job.requesterStaffUserId,
          watermark: job.watermark,
          format: job.format,
          dataClassification: job.dataClassification,
          noRawDocumentUrls: true,
          workerOutboxMessageId: message.id,
        },
      });
      return { exportId: job.exportId, status: "READY", rowCount: rows.length };
    } catch (error) {
      const permanent = toPermanentReportError(error);
      if (permanent !== null) {
        await port.fail({
          exportId: job.exportId,
          eventKey: `report-export:${job.exportId}:FAILED:${permanent.code}`,
          reasonCode: permanent.code,
          artifact: {
            requesterStaffUserId: job.requesterStaffUserId,
            watermark: job.watermark,
            format: job.format,
            failureReasonCode: permanent.code,
            noRawDocumentUrls: true,
          },
        });
      }
      throw permanent ?? error;
    }
  });
}

function reportExportPayload(payload: unknown): {
  exportId: string;
  requesterStaffUserId: string;
  requestId: string;
  report: ReportName;
  format: ReportFormat;
  dataClassification: ReportClassification;
  filters: Record<string, unknown>;
  filtersFingerprint: string;
  expectedRowCount: number;
  version: 1;
} {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new PermanentWorkerError("REPORT_EXPORT_PAYLOAD_INVALID");
  const value = payload as Record<string, unknown>;
  if (
    typeof value.exportId !== "string" ||
    typeof value.requesterStaffUserId !== "string" ||
    typeof value.requestId !== "string" ||
    !isReportName(value.report) ||
    (value.format !== "CSV" && value.format !== "JSON") ||
    (value.dataClassification !== "REDACTED" &&
      value.dataClassification !== "PERSONAL_DATA") ||
    typeof value.filtersFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.filtersFingerprint) ||
    typeof value.expectedRowCount !== "number" ||
    !Number.isSafeInteger(value.expectedRowCount) ||
    value.expectedRowCount < 0 ||
    value.expectedRowCount > 10_000_000 ||
    typeof value.filters !== "object" ||
    value.filters === null ||
    Array.isArray(value.filters) ||
    value.version !== 1 ||
    "content" in value ||
    "expectedContentHash" in value
  )
    throw new PermanentWorkerError("REPORT_EXPORT_PAYLOAD_INVALID");
  return {
    exportId: value.exportId,
    requesterStaffUserId: value.requesterStaffUserId,
    requestId: value.requestId,
    report: value.report,
    format: value.format,
    dataClassification: value.dataClassification,
    filters: value.filters as Record<string, unknown>,
    filtersFingerprint: value.filtersFingerprint,
    expectedRowCount: value.expectedRowCount,
    version: 1,
  };
}

function toPermanentReportError(error: unknown): PermanentWorkerError | null {
  if (error instanceof PermanentWorkerError) return error;
  const code =
    error !== null && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "REPORT_CURSOR_INVALID")
    return new PermanentWorkerError("REPORT_EXPORT_CURSOR_INVALID");
  if (
    code === "REPORT_AS_OF_DATE_INVALID" ||
    code === "REPORT_FILTER_INVALID" ||
    code === "REPORT_FILTER_NOT_ALLOWED" ||
    code === "REPORT_FILTER_TOO_LARGE"
  )
    return new PermanentWorkerError("REPORT_EXPORT_FILTER_INVALID");
  return null;
}

async function* databaseReportPages(
  database: Database,
  job: ReportExportJob,
): AsyncIterable<ReportExportPage> {
  let cursor: string | undefined;
  for (;;) {
    let page;
    try {
      page = await readCanonicalReportPage({
        database,
        report: job.report,
        filters: {
          ...job.filters,
          ...(cursor === undefined ? {} : { cursor }),
        },
        dataClassification: job.dataClassification,
      });
    } catch (error) {
      throw toPermanentReportError(error) ?? error;
    }
    if (page.rows.length === 0) return;
    yield {
      rows: page.rows,
    };
    if (!page.pagination.truncated) return;
    if (page.pagination.nextCursor === null)
      throw new PermanentWorkerError("REPORT_EXPORT_CURSOR_INVALID");
    cursor = page.pagination.nextCursor;
  }
}

function renderExport(
  job: ReportExportJob,
  rows: readonly Record<string, unknown>[],
): string {
  const safeRows = rows.map(
    (row) => formulaSafeValue(row) as Record<string, unknown>,
  );
  if (job.format === "JSON")
    return JSON.stringify({
      watermark: job.watermark,
      report: job.report,
      rows: safeRows,
    });
  const columns = [
    ...new Set(safeRows.flatMap((row) => Object.keys(row))),
  ].sort();
  const line = (row: Record<string, unknown>) =>
    columns.map((column) => csvCell(row[column])).join(",");
  const csv =
    columns.length === 0
      ? ""
      : [columns.join(","), ...safeRows.map(line)].join("\r\n") + "\r\n";
  return `# ${job.watermark}\r\n${csv}`;
}

function formulaSafeValue(value: unknown): unknown {
  if (typeof value === "string")
    return startsWithFormulaCharacter(value) ? `'${value}` : value;
  if (Array.isArray(value)) return value.map(formulaSafeValue);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        formulaSafeValue(item),
      ]),
    );
  return value;
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (startsWithFormulaCharacter(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function startsWithFormulaCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const character = value.charAt(index);
    if (code <= 0x1f || /\s/u.test(character)) continue;
    return (
      character === "=" ||
      character === "+" ||
      character === "-" ||
      character === "@"
    );
  }
  return false;
}

function isReportName(value: unknown): value is ReportName {
  return (
    value === "operations" ||
    value === "portfolio" ||
    value === "audit" ||
    value === "migration"
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
