import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, migrateDatabase, type Database } from "@somo/db";
import { getInternalDatabase } from "../../../packages/db/src/client.js";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { resetTestDatabase } from "../../../packages/testkit/src/index.js";
import type { StaffPrincipal } from "../src/modules/access/policy.js";
import {
  createReportService,
  serializeCsv,
} from "../src/modules/reports/service.js";
import { createMigrationService } from "../src/modules/migration/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");

describe("reporting and quarantined legacy import", () => {
  let database: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    const connection = createDatabase(databaseUrl);
    database = connection.db;
    close = connection.close;
  });

  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(database);
  });

  afterAll(async () => close());

  it("redacts personal data by role and durably attributes a safe export", async () => {
    const service = createReportService({ database });
    const auditor = principal("COMPLIANCE_AUDITOR");
    const support = principal("CUSTOMER_SUPPORT");
    await seedActor(database, auditor);
    await seedActor(database, support);
    const report = await service.operations({
      actor: support,
      filters: { status: "ACTIVE" },
    });

    expect(report).toMatchObject({
      dataClassification: "REDACTED",
      migrationTotals: expect.any(Object),
      rows: expect.any(Array),
    });
    expect(JSON.stringify(report)).not.toContain("ghanaCard");

    const exported = await service.export({
      actor: auditor,
      requestId: randomUUID(),
      report: "operations",
      filters: { status: "ACTIVE" },
      format: "CSV",
    });
    expect(exported).toMatchObject({
      dataClassification: "REDACTED",
      requesterStaffUserId: auditor.staffUserId,
      watermark: expect.stringContaining(auditor.staffUserId),
    });
    expect(exported.content).not.toMatch(/(=|\+|-|@)[^,\r\n]*/);
    const persisted = await getInternalDatabase(database).execute<{
      requester_staff_user_id: string;
      request_id: string;
      data_classification: string;
      row_count: number;
    }>(sql`
      select requester_staff_user_id, request_id, data_classification, row_count
        from report_export
       where requester_staff_user_id = ${auditor.staffUserId}
    `);
    expect(persisted.rows[0]).toMatchObject({
      requester_staff_user_id: auditor.staffUserId,
      request_id: expect.any(String),
      data_classification: "REDACTED",
      row_count: 0,
    });
    const downloaded = await service.getExport({
      actor: auditor,
      exportId: exported.id,
    });
    expect(downloaded).toMatchObject({
      id: exported.id,
      content: exported.content,
      status: "READY",
    });
    await expect(
      service.getExport({ actor: support, exportId: exported.id }),
    ).rejects.toThrow("REPORT_EXPORT_FORBIDDEN");
  });

  it("rejects personal-data exports for unauthorized roles and neutralizes CSV formulas", async () => {
    const service = createReportService({ database });
    const support = principal("CUSTOMER_SUPPORT");
    await seedActor(database, support);
    await expect(
      service.export({
        actor: support,
        requestId: randomUUID(),
        report: "operations",
        filters: { includePersonalData: true },
        format: "CSV",
      }),
    ).rejects.toThrow("REPORT_PERSONAL_DATA_FORBIDDEN");
    expect(serializeCsv([{ value: "=1+1" }, { value: "@cmd" }])).toBe(
      "value\r\n'=1+1\r\n'@cmd\r\n",
    );
  });

  it("queues large exports durably without embedding a raw report payload", async () => {
    const service = createReportService({ database });
    const support = principal("CUSTOMER_SUPPORT");
    await seedActor(database, support);
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164)
      select gen_random_uuid(), '+233200' || lpad(series::text, 7, '0')
        from generate_series(1, 501) as series
    `);
    await getInternalDatabase(database).execute(sql`
      insert into application (applicant_person_id, status)
      select id, 'ACTIVE'::application_status
        from privacy.person
       where phone_e164 like '+233200%'
    `);

    const exported = await service.export({
      actor: support,
      requestId: randomUUID(),
      report: "operations",
      format: "JSON",
    });
    expect(exported.status).toBe("QUEUED");
    expect(exported.rowCount).toBe(501);
    expect(exported.content).toBe("");
    const outbox = await getInternalDatabase(database).execute<{
      topic: string;
      aggregate_id: string;
      payload: { exportId: string; expectedRowCount: number };
    }>(sql`
      select topic, aggregate_id, payload
        from outbox_message
       where topic = 'report.export.requested'
       order by occurred_at desc
       limit 1
    `);
    expect(outbox.rows[0]).toMatchObject({
      topic: "report.export.requested",
      aggregate_id: exported.id,
      payload: { exportId: exported.id, expectedRowCount: 501 },
    });
  });

  it("quarantines duplicate identity rows and makes import replay idempotent", async () => {
    const service = createMigrationService({ database });
    const actor = principal("MIGRATION_IMPORTER");
    await seedActor(database, actor);
    const input = {
      source: "LEGACY_EXCEL",
      sourceBatchId: "batch-1",
      sourceFileHash: "a".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 2,
      rows: [
        {
          sourceRecordId: "row-1",
          sourceRowNumber: 2,
          customer: { ghanaCard: "GHA-1" },
          currentBalanceMinorUnits: "100",
        },
        {
          sourceRecordId: "row-2",
          sourceRowNumber: 3,
          customer: { ghanaCard: "GHA-1" },
          currentBalanceMinorUnits: "100",
        },
      ],
    } as const;
    const first = await service.importBatch({
      actor,
      requestId: randomUUID(),
      ...input,
    });
    const replay = await service.importBatch({
      actor,
      requestId: randomUUID(),
      ...input,
    });
    expect(first.id).toBe(replay.id);
    expect(first.status).toBe("QUARANTINED");
    expect(first.records).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "INVALID" })]),
    );
    await expect(
      service.importBatch({
        actor,
        requestId: randomUUID(),
        ...input,
        rows: [
          { ...input.rows[0], customer: { ghanaCard: "GHA-CHANGED" } },
          input.rows[1],
        ],
      }),
    ).rejects.toThrow("MIGRATION_REPLAY_CONFLICT");
  });

  it("quarantines malformed fields, duplicate contract or vehicle keys, and control-total mismatch", async () => {
    const service = createMigrationService({ database });
    const actor = principal("VERIFICATION_OFFICER");
    await seedActor(database, actor);
    const batch = await service.importBatch({
      actor,
      requestId: randomUUID(),
      source: "LEGACY_CSV",
      sourceBatchId: "batch-invalid-fields",
      sourceFileHash: "d".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 2,
      controlTotalMinorUnits: "300",
      rows: [
        {
          sourceRecordId: "invalid-1",
          sourceRowNumber: 2,
          customer: { phoneE164: "+233200000001", ghanaCard: "GHA-1" },
          contract: { reference: "CONTRACT-1" },
          vehicle: { vin: "VIN-1" },
          currentBalanceMinorUnits: "100",
        },
        {
          sourceRecordId: "invalid-2",
          sourceRowNumber: 3,
          customer: { phoneE164: "not-a-phone", ghanaCard: "GHA-1" },
          contract: { reference: "CONTRACT-1" },
          vehicle: { vin: "VIN-1" },
          currentBalanceMinorUnits: "bad",
        },
      ],
    });
    expect(batch.status).toBe("QUARANTINED");
    const codes = batch.records.flatMap((record) =>
      record.errors.map((error) => String(error.code)),
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        "DUPLICATE_GHANA_CARD",
        "DUPLICATE_CONTRACT_REFERENCE",
        "DUPLICATE_VEHICLE_IDENTIFIER",
        "CURRENT_BALANCE_INVALID",
        "PHONE_INVALID",
        "ATTACHMENT_REQUIRED",
        "CONTROL_TOTAL_MISMATCH",
      ]),
    );
  });

  it("quarantines a live identity collision without guessing a merge", async () => {
    const service = createMigrationService({ database });
    const actor = principal("VERIFICATION_OFFICER");
    await seedActor(database, actor);
    const fingerprint = "9".repeat(64);
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164, ghana_card_fingerprint)
      values (${randomUUID()}, '+233200000088', ${fingerprint})
    `);
    const batch = await service.importBatch({
      actor,
      requestId: randomUUID(),
      source: "LEGACY_EXCEL",
      sourceBatchId: "batch-live-collision",
      sourceFileHash: "8".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 1,
      rows: [
        {
          sourceRecordId: "collision-1",
          sourceRowNumber: 2,
          customer: {
            phoneE164: "+233200000087",
            ghanaCardFingerprint: fingerprint,
          },
          currentBalanceMinorUnits: "100",
        },
      ],
    });
    expect(batch.status).toBe("QUARANTINED");
    expect(batch.records[0]).toMatchObject({
      errors: expect.arrayContaining([
        expect.objectContaining({ code: "LIVE_RECORD_COLLISION" }),
      ]),
      matchCandidates: [expect.objectContaining({ kind: "PERSON" })],
    });
  });

  it("requires distinct verifier and finance approver before activation", async () => {
    const service = createMigrationService({ database });
    const importer = principal("VERIFICATION_OFFICER");
    const verifier = principal("VERIFICATION_OFFICER");
    const finance = principal("CFO");
    await seedActor(database, importer);
    await seedActor(database, verifier);
    await seedActor(database, finance);
    const batch = await service.importBatch({
      actor: importer,
      requestId: randomUUID(),
      source: "LEGACY_CSV",
      sourceBatchId: "batch-valid",
      sourceFileHash: "b".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 0,
      rows: [],
    });
    await expect(
      service.verifyBatch({
        batchId: batch.id,
        actor: importer,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("MIGRATION_SEPARATION_REQUIRED");
    const verified = await service.verifyBatch({
      batchId: batch.id,
      actor: verifier,
      requestId: randomUUID(),
    });
    expect(verified.status).toBe("VALIDATED");
    const approved = await service.approveBatch({
      batchId: batch.id,
      actor: finance,
      requestId: randomUUID(),
      financialEvidenceHash: "c".repeat(64),
    });
    expect(approved.status).toBe("APPROVED");
    const activated = await service.activateBatch({
      batchId: batch.id,
      actor: finance,
      requestId: randomUUID(),
    });
    expect(activated.status).toBe("IMPORTED");
    const outbox = await getInternalDatabase(database).execute<{
      aggregate_id: string;
      topic: string;
    }>(sql`
      select aggregate_id, topic
        from outbox_message
       where topic = 'migration.batch.activated'
         and aggregate_id = ${batch.id}
    `);
    expect(outbox.rows).toEqual([
      { aggregate_id: batch.id, topic: "migration.batch.activated" },
    ]);
  });

  it("activates only a clean bound attachment after verification and finance approval", async () => {
    const service = createMigrationService({ database });
    const importer = principal("VERIFICATION_OFFICER");
    const verifier = principal("VERIFICATION_OFFICER");
    const finance = principal("CFO");
    await seedActor(database, importer);
    await seedActor(database, verifier);
    await seedActor(database, finance);
    const documentOwnerId = randomUUID();
    const documentId = randomUUID();
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164)
      values (${documentOwnerId}, '+233200000099')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into privacy.document
        (id, person_id, document_type, object_key, declared_mime_type,
         declared_size_bytes, upload_ticket_hash, upload_expires_at,
         accepted_object_key, accepted_object_version_id, accepted_object_etag,
         sha256, status, malware_scanned)
      values
        (${documentId}, ${documentOwnerId}, 'LEGACY_SCAN', ${`incoming/${documentId}`},
         'application/pdf', 128, ${"f".repeat(64)}, now() + interval '1 day',
         ${`accepted/${documentId}`}, 'v1', 'etag-1', ${"1".repeat(64)}, 'ACCEPTED', true)
    `);
    const batch = await service.importBatch({
      actor: importer,
      requestId: randomUUID(),
      source: "LEGACY_PAPER",
      sourceBatchId: "paper-bound-1",
      sourceFileHash: "e".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 1,
      controlTotalMinorUnits: "100",
      rows: [
        {
          sourceRecordId: "paper-row-1",
          sourceRowNumber: 1,
          customer: {
            phoneE164: "+233200000002",
            ghanaCardFingerprint: "e".repeat(64),
          },
          currentBalanceMinorUnits: "100",
          attachmentDocumentId: documentId,
        },
      ],
    });
    expect(batch.status).toBe("VALIDATED");
    await service.verifyBatch({
      batchId: batch.id,
      actor: verifier,
      requestId: randomUUID(),
    });
    await service.approveBatch({
      batchId: batch.id,
      actor: finance,
      requestId: randomUUID(),
      financialEvidenceHash: "1".repeat(64),
    });
    const activated = await service.activateBatch({
      batchId: batch.id,
      actor: finance,
      requestId: randomUUID(),
    });
    expect(activated.status).toBe("IMPORTED");
    expect(activated.records[0]).toMatchObject({
      status: "IMPORTED",
      targetId: expect.any(String),
    });
    const target = await getInternalDatabase(database).execute<{
      status: string;
    }>(sql`
      select a.status
        from application a
        join migration_record r on r.target_id = a.id
       where r.migration_batch_id = ${batch.id}
    `);
    expect(target.rows).toEqual([{ status: "ACTIVE" }]);
  });
});

function principal(role: string): StaffPrincipal {
  return {
    kind: "staff",
    staffUserId: randomUUID(),
    roles: [role as StaffPrincipal["roles"][number]],
    sessionId: randomUUID(),
  };
}

async function seedActor(
  database: Database,
  actor: StaffPrincipal,
): Promise<void> {
  await getInternalDatabase(database).execute(sql`
    insert into staff_user (id, email, password_hash, status)
    values (${actor.staffUserId}, ${`${actor.staffUserId}@example.test`}, 'hash', 'ACTIVE')
  `);
}
