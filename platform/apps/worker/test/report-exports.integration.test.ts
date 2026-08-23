import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { createDatabase, migrateDatabase, type Database } from "@somo/db";
import { getInternalDatabase } from "../../../packages/db/src/client.js";
import { resetTestDatabase } from "@somo/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabaseReportExportCompletionPort,
  createReportExportHandler,
} from "../src/jobs/report-exports.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error("TEST_DATABASE_URL is required for worker integration tests");

describe("PostgreSQL report export worker", () => {
  let database: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db: database, close } = createDatabase(databaseUrl));
  });
  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(database);
  });
  afterAll(async () => close());

  it("appends one READY event and survives worker replay", async () => {
    const staffId = randomUUID();
    const exportId = randomUUID();
    const requestId = randomUUID();
    await getInternalDatabase(database).execute(sql`
      insert into staff_user (id, email, password_hash, status)
      values (${staffId}, ${staffId + "@example.test"}, 'hash', 'ACTIVE')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into report_export
        (id, requester_staff_user_id, request_id, report_type, format,
         data_classification, filters, row_count, content_hash, artifact, status)
      values
        (${exportId}, ${staffId}, ${requestId}, 'OPERATIONS', 'JSON',
         'REDACTED', '{}'::jsonb, 501, ${"a".repeat(64)},
         '{"watermark":"SOMOCO"}'::jsonb, 'QUEUED')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into report_export_event
        (report_export_id, event_key, event_type, content_hash, artifact)
      values
        (${exportId}, ${`report-export:${exportId}:QUEUED`}, 'QUEUED', ${"a".repeat(64)},
         '{"watermark":"SOMOCO"}'::jsonb)
    `);
    const content = JSON.stringify({ rows: [{ safe: true }] });
    const handler = createReportExportHandler(
      createDatabaseReportExportCompletionPort(database),
    );
    const message = {
      id: randomUUID(),
      topic: "report.export.requested",
      aggregateType: "report_export",
      aggregateId: exportId,
      occurredAt: new Date(),
      attempts: 1,
      payload: {
        exportId,
        content,
        expectedContentHash: createHash("sha256")
          .update(content, "utf8")
          .digest("hex"),
        format: "JSON",
        watermark: "SOMOCO",
      },
    };
    await handler(message);
    await handler(message);
    const events = await getInternalDatabase(database).execute<{
      event_type: string;
      content_hash: string | null;
    }>(sql`
      select event_type, content_hash
        from report_export_event
       where report_export_id = ${exportId}
       order by created_at asc, id asc
    `);
    expect(events.rows).toHaveLength(2);
    expect(events.rows[1]).toMatchObject({ event_type: "READY" });
  });
});
