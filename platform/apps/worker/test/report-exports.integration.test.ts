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
import { createReportService } from "../../api/src/modules/reports/service.js";

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
        requesterStaffUserId: staffId,
        requestId,
        report: "operations",
        format: "JSON",
        dataClassification: "REDACTED",
        filters: {},
        filtersFingerprint: createHash("sha256")
          .update("{}", "utf8")
          .digest("hex"),
        version: 1,
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

  it("persists a sanitized FAILED event for a forged worker request", async () => {
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
         'REDACTED', '{}'::jsonb, 501, ${"0".repeat(64)},
         '{"watermark":"SOMOCO"}'::jsonb, 'QUEUED')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into report_export_event
        (report_export_id, event_key, event_type, artifact)
      values
        (${exportId}, ${`report-export:${exportId}:QUEUED`}, 'QUEUED',
         '{"watermark":"SOMOCO","filtersFingerprint":"99914b932bd37a50b983c5e7c90ae93bafc5d4b2f2a6f5f7f1f8f5f9f0f8f7f6"}'::jsonb)
    `);
    const handler = createReportExportHandler(
      createDatabaseReportExportCompletionPort(database),
    );
    await expect(
      handler({
        id: randomUUID(),
        topic: "report.export.requested",
        aggregateType: "report_export",
        aggregateId: exportId,
        occurredAt: new Date(),
        attempts: 1,
        payload: {
          exportId,
          requesterStaffUserId: randomUUID(),
          requestId,
          report: "operations",
          format: "JSON",
          dataClassification: "REDACTED",
          filters: {},
          filtersFingerprint: createHash("sha256").update("{}").digest("hex"),
          version: 1,
        },
      }),
    ).rejects.toThrow("PERMANENT_WORKER_FAILURE");
    const events = await getInternalDatabase(database).execute<{
      event_type: string;
      reason_code: string | null;
    }>(sql`
      select event_type, reason_code from report_export_event
       where report_export_id = ${exportId}
       order by created_at asc, id asc
    `);
    expect(events.rows.at(-1)).toEqual({
      event_type: "FAILED",
      reason_code: "REPORT_EXPORT_REQUEST_MISMATCH",
    });
  });

  it("walks every bounded page when generating a large export", async () => {
    const staffId = randomUUID();
    const exportId = randomUUID();
    const requestId = randomUUID();
    await getInternalDatabase(database).execute(sql`
      insert into staff_user (id, email, password_hash, status)
      values (${staffId}, ${staffId + "@example.test"}, 'hash', 'ACTIVE')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164)
      select gen_random_uuid(), '+233220' || lpad(series::text, 7, '0')
        from generate_series(1, 1001) as series
    `);
    await getInternalDatabase(database).execute(sql`
      insert into application (applicant_person_id, status)
      select id, 'ACTIVE'::application_status
        from privacy.person where phone_e164 like '+233220%'
    `);
    await getInternalDatabase(database).execute(sql`
      insert into report_export
        (id, requester_staff_user_id, request_id, report_type, format,
         data_classification, filters, row_count, content_hash, artifact, status)
      values
        (${exportId}, ${staffId}, ${requestId}, 'OPERATIONS', 'JSON',
         'REDACTED', '{}'::jsonb, 1001, ${"0".repeat(64)},
         ${JSON.stringify({
           watermark: "SOMOCO LARGE EXPORT",
           filtersFingerprint: createHash("sha256").update("{}").digest("hex"),
         })}::jsonb, 'QUEUED')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into report_export_event
        (report_export_id, event_key, event_type, artifact)
      values
        (${exportId}, ${`report-export:${exportId}:QUEUED`}, 'QUEUED',
         ${JSON.stringify({
           watermark: "SOMOCO LARGE EXPORT",
           filtersFingerprint: createHash("sha256").update("{}").digest("hex"),
         })}::jsonb)
    `);
    const handler = createReportExportHandler(
      createDatabaseReportExportCompletionPort(database),
    );
    await handler({
      id: randomUUID(),
      topic: "report.export.requested",
      aggregateType: "report_export",
      aggregateId: exportId,
      occurredAt: new Date(),
      attempts: 1,
      payload: {
        exportId,
        requesterStaffUserId: staffId,
        requestId,
        report: "operations",
        format: "JSON",
        dataClassification: "REDACTED",
        filters: {},
        filtersFingerprint: createHash("sha256").update("{}").digest("hex"),
        version: 1,
      },
    });
    const ready = await getInternalDatabase(database).execute<{
      artifact: { rowCount?: number };
    }>(sql`
      select artifact from report_export_event
       where report_export_id = ${exportId} and event_type = 'READY'
    `);
    expect(ready.rows[0]?.artifact.rowCount).toBe(1001);
  });

  it("matches the API report projection for a queued export", async () => {
    const staffId = randomUUID();
    await getInternalDatabase(database).execute(sql`
      insert into staff_user (id, email, password_hash, status)
      values (${staffId}, ${staffId + "@example.test"}, 'hash', 'ACTIVE')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164)
      select gen_random_uuid(), '+233230' || lpad(series::text, 7, '0')
        from generate_series(1, 501) as series
    `);
    await getInternalDatabase(database).execute(sql`
      insert into application (applicant_person_id, status)
      select id, 'ACTIVE'::application_status
        from privacy.person where phone_e164 like '+233230%'
    `);
    const actor = {
      kind: "staff" as const,
      staffUserId: staffId,
      roles: ["CUSTOMER_SUPPORT" as const],
      sessionId: randomUUID(),
    };
    const reportService = createReportService({ database });
    const apiReport = await reportService.operations({
      actor,
      filters: { status: "ACTIVE" },
    });
    const exported = await reportService.export({
      actor,
      requestId: randomUUID(),
      report: "operations",
      filters: { status: "ACTIVE" },
      format: "JSON",
    });
    expect(exported.status).toBe("QUEUED");
    const outbox = await getInternalDatabase(database).execute<{
      id: string;
      payload: Record<string, unknown>;
    }>(sql`
      select id, payload
        from outbox_message
       where aggregate_id = ${exported.id}
         and topic = 'report.export.requested'
       limit 1
    `);
    const message = {
      id: outbox.rows[0]!.id,
      topic: "report.export.requested",
      aggregateType: "report_export",
      aggregateId: exported.id,
      occurredAt: new Date(),
      attempts: 1,
      payload: outbox.rows[0]!.payload,
    };
    const handler = createReportExportHandler(
      createDatabaseReportExportCompletionPort(database),
    );
    await handler(message);
    const ready = await getInternalDatabase(database).execute<{
      artifact: { content?: string };
    }>(sql`
      select artifact
        from report_export_event
       where report_export_id = ${exported.id}
         and event_type = 'READY'
    `);
    const workerRows = JSON.parse(ready.rows[0]!.artifact.content!).rows;
    expect(workerRows).toEqual(apiReport.rows);
  });
});
