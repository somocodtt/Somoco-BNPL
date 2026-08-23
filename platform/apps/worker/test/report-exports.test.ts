import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createReportExportHandler } from "../src/jobs/report-exports.js";
import type { ReportExportCompletionPort } from "../src/jobs/report-exports.js";

describe("report export worker", () => {
  it("completes a queued artifact exactly once across replayed delivery", async () => {
    const completed: string[] = [];
    const keys = new Set<string>();
    const port: ReportExportCompletionPort = {
      async complete(input) {
        if (keys.has(input.eventKey)) return false;
        keys.add(input.eventKey);
        completed.push(input.exportId);
        return true;
      },
    };
    const content = JSON.stringify({ rows: [{ safe: true }] });
    const handler = createReportExportHandler(port);
    const message = {
      id: "outbox-report-1",
      topic: "report.export.requested",
      aggregateType: "report_export",
      aggregateId: "export-1",
      occurredAt: new Date("2026-08-22T00:00:00Z"),
      attempts: 1,
      payload: {
        exportId: "export-1",
        content,
        expectedContentHash: createHash("sha256")
          .update(content, "utf8")
          .digest("hex"),
        format: "JSON",
        watermark: "SOMOCO CONFIDENTIAL",
      },
    };
    await handler(message);
    await handler(message);
    expect(completed).toEqual(["export-1"]);
  });
});
