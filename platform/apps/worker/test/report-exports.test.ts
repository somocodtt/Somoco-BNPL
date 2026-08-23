import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createReportExportHandler,
  type ReportExportCompletionPort,
  type ReportExportJob,
} from "../src/jobs/report-exports.js";

const fingerprint = "a".repeat(64);

function job(): ReportExportJob {
  return {
    exportId: "export-1",
    requesterStaffUserId: "staff-1",
    requestId: "request-1",
    report: "operations",
    format: "JSON",
    dataClassification: "REDACTED",
    filters: {},
    filtersFingerprint: fingerprint,
    watermark: "SOMOCO CONFIDENTIAL | requester=staff-1",
    status: "QUEUED",
  };
}

function portFor(current: ReportExportJob = job()) {
  const completed: Array<Record<string, unknown>> = [];
  const failures: Array<Record<string, unknown>> = [];
  const port: ReportExportCompletionPort = {
    async load() {
      return current;
    },
    async *generate() {
      yield { rows: [{ safe: true }] };
      yield { rows: [{ second: true }] };
    },
    async complete(input) {
      completed.push(input);
      current = { ...current, status: "READY" };
      return true;
    },
    async fail(input) {
      failures.push(input);
      current = { ...current, status: "FAILED" };
      return true;
    },
  };
  return { port, completed, failures };
}

function message(overrides: Record<string, unknown> = {}) {
  return {
    id: "outbox-report-1",
    topic: "report.export.requested",
    aggregateType: "report_export",
    aggregateId: "export-1",
    occurredAt: new Date("2026-08-22T00:00:00Z"),
    attempts: 1,
    payload: {
      exportId: "export-1",
      requesterStaffUserId: "staff-1",
      requestId: "request-1",
      report: "operations",
      format: "JSON",
      dataClassification: "REDACTED",
      filters: {},
      filtersFingerprint: fingerprint,
      version: 1,
      ...overrides,
    },
  } as const;
}

describe("report export worker", () => {
  it("generates bounded pages and completes a queued artifact exactly once across replay", async () => {
    const { port, completed } = portFor();
    const handler = createReportExportHandler(port);
    await handler(message());
    await handler(message());
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ exportId: "export-1", rowCount: 2 });
    const content = String(
      (completed[0]?.artifact as Record<string, unknown>).content,
    );
    expect(content).toContain("SOMOCO CONFIDENTIAL");
    expect(createHash("sha256").update(content, "utf8").digest("hex")).toBe(
      completed[0]?.contentHash,
    );
  });

  it("rejects a message routed to a different export aggregate and records failure", async () => {
    const { port, failures } = portFor();
    const handler = createReportExportHandler(port);
    await expect(
      handler({ ...message(), aggregateId: "export-other" }),
    ).rejects.toThrow("PERMANENT_WORKER_FAILURE");
    expect(failures).toMatchObject([
      { reasonCode: "REPORT_EXPORT_AGGREGATE_MISMATCH" },
    ]);
  });

  it("fails a forged request without invoking generation", async () => {
    const { port, failures } = portFor();
    let generated = false;
    port.generate = async function* () {
      generated = true;
      yield { rows: [] };
    };
    const handler = createReportExportHandler(port);
    await expect(
      handler(message({ requesterStaffUserId: "other-staff" })),
    ).rejects.toThrow("PERMANENT_WORKER_FAILURE");
    expect(generated).toBe(false);
    expect(failures).toMatchObject([
      { reasonCode: "REPORT_EXPORT_REQUEST_MISMATCH" },
    ]);
  });
});
