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
import {
  createMigrationService,
  type LegacyImportRow,
  type MigrationService,
} from "../src/modules/migration/service.js";

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
    expect(exported.content.split("\r\n").slice(1).join("\r\n")).not.toMatch(
      /(=|\+|-|@)[^,\r\n]*/,
    );
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
    expect(
      serializeCsv([{ value: "  =1+1" }, { nested: { value: "\t@cmd" } }]),
    ).toContain("'  =1+1");
    expect(serializeCsv([{ nested: { value: "\t@cmd" } }])).not.toContain(
      "\t@cmd",
    );
  });

  it("authorizes export polling from the persisted report scope and rejects unsafe filters", async () => {
    const service = createReportService({ database });
    const importer = principal("MIGRATION_IMPORTER");
    const support = principal("CUSTOMER_SUPPORT");
    await seedActor(database, importer);
    await seedActor(database, support);
    const migration = await service.export({
      actor: importer,
      requestId: randomUUID(),
      report: "migration",
      format: "JSON",
    });
    await expect(
      service.getExport({ actor: importer, exportId: migration.id }),
    ).resolves.toMatchObject({ id: migration.id, report: "migration" });

    const operations = await service.export({
      actor: support,
      requestId: randomUUID(),
      report: "operations",
      format: "JSON",
    });
    await expect(
      service.getExport({ actor: importer, exportId: operations.id }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      service.getExport({ actor: support, exportId: migration.id }),
    ).rejects.toThrow("FORBIDDEN");

    await expect(
      service.operations({
        actor: support,
        filters: { unknownFilter: "not allowed" },
      }),
    ).rejects.toThrow("REPORT_FILTER_NOT_ALLOWED");
    await expect(
      service.operations({
        actor: support,
        filters: { status: "x".repeat(129) },
      }),
    ).rejects.toThrow("REPORT_FILTER_TOO_LARGE");
    await expect(
      service.export({
        actor: support,
        requestId: randomUUID(),
        report: "operations",
        filters: { status: "ACTIVE", oversized: ["x".repeat(128)] },
        format: "JSON",
      }),
    ).rejects.toThrow("REPORT_FILTER_NOT_ALLOWED");
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
    expect(outbox.rows[0]?.payload).not.toHaveProperty("content");
    expect(outbox.rows[0]?.payload).not.toHaveProperty("expectedContentHash");
    const events = await getInternalDatabase(database).execute<{
      event_type: string;
    }>(sql`
      select event_type
        from report_export_event
       where report_export_id = ${exported.id}
       order by created_at asc
    `);
    expect(events.rows).toEqual([{ event_type: "QUEUED" }]);
  });

  it("recursively redacts nested audit evidence and applies an as-of boundary", async () => {
    const service = createReportService({ database });
    const support = principal("COMPLIANCE_AUDITOR");
    await seedActor(database, support);
    await getInternalDatabase(database).execute(sql`
      insert into audit_event
        (aggregate_type, aggregate_id, action, actor_staff_user_id,
         request_id, data, occurred_at)
      values
        ('test', ${randomUUID()}, 'TEST', ${support.staffUserId}, ${randomUUID()},
         ${JSON.stringify({
           safe: "visible",
           nested: { secret: "nested-secret", documentUrl: "https://private" },
           values: [{ token: "nested-token", ok: true }],
         })}::jsonb,
         '2020-01-01T00:00:00Z')
    `);
    const audit = await service.audit({ actor: support });
    expect(JSON.stringify(audit.rows)).not.toContain("nested-secret");
    expect(JSON.stringify(audit.rows)).not.toContain("nested-token");

    const beforeId = randomUUID();
    const afterId = randomUUID();
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164)
      values (${beforeId}, '+233200000111'), (${afterId}, '+233200000112')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into application (id, applicant_person_id, status, created_at)
      values
        (${randomUUID()}, ${beforeId}, 'ACTIVE', '2020-01-01T00:00:00Z'),
        (${randomUUID()}, ${afterId}, 'ACTIVE', '2030-01-01T00:00:00Z')
    `);
    await getInternalDatabase(database).execute(sql`
      insert into privacy.identity_check
        (id, person_id, provider, provider_correlation_id, status, evidence,
         checked_at, created_at)
      values
        (${randomUUID()}, ${beforeId}, 'NIA', ${randomUUID()}, 'FAILED', '{}',
         '2020-01-02T00:00:00Z', '2020-01-02T00:00:00Z'),
        (${randomUUID()}, ${beforeId}, 'NIA', ${randomUUID()}, 'FAILED', '{}',
         '2030-01-02T00:00:00Z', '2030-01-02T00:00:00Z')
    `);
    const asOf = await service.operations({
      actor: support,
      filters: { asOfDate: "2025-01-01" },
    });
    expect(asOf.rows).toHaveLength(1);
    expect(asOf.rows[0]?.niaExceptions).toBe(1);
  });

  it("uses a real ordered cursor for reports beyond one page", async () => {
    const service = createReportService({ database });
    const support = principal("CUSTOMER_SUPPORT");
    await seedActor(database, support);
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164)
      select gen_random_uuid(), '+233210' || lpad(series::text, 7, '0')
        from generate_series(1, 1001) as series
    `);
    await getInternalDatabase(database).execute(sql`
      insert into application (applicant_person_id, status)
      select id, 'ACTIVE'::application_status
        from privacy.person
       where phone_e164 like '+233210%'
    `);
    const first = await service.operations({ actor: support });
    expect(first.rows).toHaveLength(1000);
    expect(first.pagination.truncated).toBe(true);
    expect(first.pagination.nextCursor).toEqual(expect.any(String));
    const second = await service.operations({
      actor: support,
      filters: { cursor: first.pagination.nextCursor! },
    });
    expect(second.rows.length).toBeGreaterThan(0);
    expect(
      new Set([
        ...first.rows.map((row) => String(row.applicationId)),
        ...second.rows.map((row) => String(row.applicationId)),
      ]).size,
    ).toBe(first.rows.length + second.rows.length);
    expect(second.rows[0]?.applicationId).not.toBe(
      first.rows[0]?.applicationId,
    );
  });

  it("does not mutate immutable migration target evidence", async () => {
    const service = createMigrationService({ database });
    const actor = principal("MIGRATION_IMPORTER");
    await seedActor(database, actor);
    const batch = await service.importBatch({
      actor,
      requestId: randomUUID(),
      source: "LEGACY_EXCEL",
      sourceBatchId: "append-only-target",
      sourceFileHash: "7".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 1,
      rows: [
        {
          sourceRecordId: "append-only-row",
          sourceRowNumber: 2,
          customer: {
            phoneE164: "+233200000113",
            ghanaCardFingerprint: "6".repeat(64),
          },
          currentBalanceMinorUnits: "100",
        },
      ],
    });
    await expect(
      getInternalDatabase(database).execute(sql`
        update migration_record
           set target_type = 'application', target_id = ${randomUUID()}
         where migration_batch_id = ${batch.id}
      `),
    ).rejects.toThrow();
  });

  it("serializes concurrent imports of the same file evidence", async () => {
    const service = createMigrationService({ database });
    const actor = principal("MIGRATION_IMPORTER");
    await seedActor(database, actor);
    const common = {
      actor,
      source: "LEGACY_EXCEL" as const,
      sourceFileHash: "1".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 0,
      rows: [],
    };
    const results = await Promise.allSettled([
      service.importBatch({
        ...common,
        sourceBatchId: "concurrent-a",
        requestId: randomUUID(),
      }),
      service.importBatch({
        ...common,
        sourceBatchId: "concurrent-b",
        requestId: randomUUID(),
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rows = await getInternalDatabase(database).execute<{
      count: number;
    }>(sql`
      select count(*)::int as count
        from migration_batch
       where source_file_hash = ${common.sourceFileHash}
    `);
    expect(rows.rows[0]?.count).toBe(1);
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
        sourceBatchId: "batch-1-replayed-under-another-key",
      }),
    ).rejects.toThrow("MIGRATION_REPLAY_CONFLICT");
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
    await expect(
      service.importBatch({
        actor,
        requestId: randomUUID(),
        ...input,
        controlTotalMinorUnits: "201",
      }),
    ).rejects.toThrow("MIGRATION_REPLAY_CONFLICT");
    await expect(
      service.importBatch({
        actor,
        requestId: randomUUID(),
        ...input,
        rows: [input.rows[1], input.rows[0]],
      }),
    ).rejects.toThrow("MIGRATION_REPLAY_CONFLICT");
  });

  it("keeps migration batch lifecycle state append-only", async () => {
    const service = createMigrationService({ database });
    const importer = principal("MIGRATION_IMPORTER");
    await seedActor(database, importer);
    const batch = await service.importBatch({
      actor: importer,
      requestId: randomUUID(),
      source: "LEGACY_CSV",
      sourceBatchId: "append-only-batch-state",
      sourceFileHash: "f".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 0,
      rows: [],
    });
    await expect(
      getInternalDatabase(database).execute(sql`
        update migration_batch set status = 'APPROVED' where id = ${batch.id}
      `),
    ).rejects.toThrow();
    await expect(
      getInternalDatabase(database).execute(sql`
        delete from migration_batch where id = ${batch.id}
      `),
    ).rejects.toThrow();
    const current = await service.listBatches(importer);
    expect(current.find((item) => item.id === batch.id)?.status).toBe(
      batch.status,
    );
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

  it("requires complete applicant, guarantor, contract, and vehicle identity fields", async () => {
    const service = createMigrationService({ database });
    const actor = principal("MIGRATION_IMPORTER");
    await seedActor(database, actor);
    const batch = await service.importBatch({
      actor,
      requestId: randomUUID(),
      source: "LEGACY_CSV",
      sourceBatchId: "batch-required-identity-fields",
      sourceFileHash: "2".repeat(64),
      templateVersion: "legacy-v1",
      expectedRecords: 1,
      rows: [
        {
          sourceRecordId: "required-fields-row",
          sourceRowNumber: 2,
          customer: {
            phoneE164: "+233200000014",
            ghanaCardFingerprint: "a".repeat(64),
          },
          guarantor: {
            phoneE164: "+233200000015",
            ghanaCardFingerprint: "b".repeat(64),
          },
          contract: {
            reference: "REQUIRED-FIELDS-CONTRACT",
            startDate: "2025-01-01",
            endDate: "2026-01-01",
          },
          vehicle: { vin: "REQUIRED-FIELDS-VIN" },
          repaymentFrequency: "MONTHLY",
          tenureMonths: 12,
          arrearsMinorUnits: "0",
          repaymentHistory: [],
          installmentSchedule: monthlySchedule(),
          currentBalanceMinorUnits: "100",
        },
      ],
    });
    const codes = batch.records.flatMap((record) =>
      record.errors.map((error) => String(error.code)),
    );
    expect(codes).toEqual(
      expect.arrayContaining([
        "APPLICANT_LEGACY_ID_REQUIRED",
        "APPLICANT_NAME_REQUIRED",
        "APPLICANT_DATE_OF_BIRTH_INVALID",
        "GUARANTOR_LEGACY_ID_REQUIRED",
        "GUARANTOR_NAME_REQUIRED",
        "GUARANTOR_DATE_OF_BIRTH_INVALID",
        "CONTRACT_LEGACY_ID_REQUIRED",
        "VEHICLE_LEGACY_ID_REQUIRED",
        "VEHICLE_MODEL_REQUIRED",
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
        sampleRecordIds: [],
      }),
    ).rejects.toThrow("MIGRATION_SEPARATION_REQUIRED");
    const verified = await service.verifyBatch({
      batchId: batch.id,
      actor: verifier,
      requestId: randomUUID(),
      sampleRecordIds: [],
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

  it("persists a final live conflict quarantine outside the failed activation transaction", async () => {
    const service = createMigrationService({ database });
    const { batch, finance, applicantFingerprint } =
      await createApprovedBoundBatch(database, service, "live-conflict");
    await getInternalDatabase(database).execute(sql`
      insert into privacy.person (id, phone_e164, ghana_card_fingerprint)
      values (${randomUUID()}, '+233200000077', ${applicantFingerprint})
    `);
    await expect(
      service.activateBatch({
        batchId: batch.id,
        actor: finance,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("MIGRATION_LIVE_RECORD_CONFLICT");
    const persisted = (await service.listBatches(finance)).find(
      (item) => item.id === batch.id,
    );
    expect(persisted).toMatchObject({ status: "QUARANTINED" });
    expect(persisted?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "QUARANTINED",
          reasonCode: "MIGRATION_LIVE_RECORD_CONFLICT",
        }),
      ]),
    );
  });

  it("does not treat a prior failed sample as a passing verification", async () => {
    const service = createMigrationService({ database });
    const verifier = principal("VERIFICATION_OFFICER");
    await seedActor(database, verifier);
    const { batch } = await createApprovedBoundBatch(
      database,
      service,
      "previous-fail",
      true,
    );
    const recordId = batch.records[0]!.id;
    await getInternalDatabase(database).execute(sql`
      insert into migration_sample_evidence
        (migration_batch_id, migration_record_id, verifier_staff_user_id,
         result, evidence_hash)
      values (${batch.id}, ${recordId}, ${verifier.staffUserId}, 'FAIL', NULL)
    `);
    await expect(
      service.verifyBatch({
        batchId: batch.id,
        actor: verifier,
        requestId: randomUUID(),
        sampleRecordIds: [recordId],
      }),
    ).rejects.toThrow("MIGRATION_SAMPLE_PREVIOUS_FAIL");
    const evidence = await getInternalDatabase(database).execute<{
      result: string;
    }>(sql`
      select result
        from migration_sample_evidence
       where migration_batch_id = ${batch.id}
         and migration_record_id = ${recordId}
    `);
    expect(evidence.rows).toEqual([{ result: "FAIL" }]);
  });

  it("quarantines inconsistent contract, schedule, repayment, arrears, and term evidence", async () => {
    const service = createMigrationService({ database });
    const actor = principal("MIGRATION_IMPORTER");
    await seedActor(database, actor);
    const cases: readonly {
      suffix: string;
      code: string;
      overrides: Record<string, unknown>;
    }[] = [
      {
        suffix: "schedule-total",
        code: "INSTALLMENT_SCHEDULE_TOTAL_MISMATCH",
        overrides: {
          installmentSchedule: [
            {
              number: 1,
              dueDate: "2025-02-01",
              amountMinorUnits: "90",
              status: "DUE",
              currency: "GHS",
            },
          ],
        },
      },
      {
        suffix: "schedule-order",
        code: "INSTALLMENT_SCHEDULE_ORDER_INVALID",
        overrides: {
          installmentSchedule: [
            {
              number: 2,
              dueDate: "2025-03-01",
              amountMinorUnits: "50",
              status: "DUE",
              currency: "GHS",
            },
            {
              number: 1,
              dueDate: "2025-02-01",
              amountMinorUnits: "50",
              status: "DUE",
              currency: "GHS",
            },
          ],
        },
      },
      {
        suffix: "repayment-net",
        code: "REPAYMENT_TOTAL_MISMATCH",
        overrides: {
          totalPaidMinorUnits: "70",
          currentBalanceMinorUnits: "30",
          repaymentHistory: [
            {
              date: "2025-01-10",
              amountMinorUnits: "80",
              type: "PAYMENT",
              reference: "PAY-1",
              currency: "GHS",
            },
            {
              date: "2025-01-11",
              amountMinorUnits: "20",
              type: "REVERSAL",
              reference: "REV-1",
              currency: "GHS",
            },
          ],
        },
      },
      {
        suffix: "arrears",
        code: "ARREARS_RECONCILIATION_MISMATCH",
        overrides: { arrearsMinorUnits: "0", arrearsAsOfDate: "2025-03-01" },
      },
      {
        suffix: "term",
        code: "TENURE_DATE_RANGE_INVALID",
        overrides: { tenureMonths: 6 },
      },
      {
        suffix: "paid-over-total",
        code: "REPAYMENT_EXCEEDS_CONTRACT_TOTAL",
        overrides: {
          totalPaidMinorUnits: "120",
          currentBalanceMinorUnits: "0",
          repaymentHistory: [
            {
              date: "2025-01-10",
              amountMinorUnits: "120",
              type: "PAYMENT",
              reference: "PAY-OVER",
              currency: "GHS",
            },
          ],
        },
      },
      {
        suffix: "weekly-cadence",
        code: "INSTALLMENT_SCHEDULE_CADENCE_INVALID",
        overrides: {
          repaymentFrequency: "WEEKLY",
          installmentSchedule: [
            {
              number: 1,
              dueDate: "2025-01-08",
              amountMinorUnits: "50",
              status: "UNPAID",
              currency: "GHS",
            },
            {
              number: 2,
              dueDate: "2025-01-16",
              amountMinorUnits: "50",
              status: "UNPAID",
              currency: "GHS",
            },
          ],
        },
      },
      {
        suffix: "maturity-coverage",
        code: "INSTALLMENT_SCHEDULE_COVERAGE_INVALID",
        overrides: {
          repaymentFrequency: "MONTHLY",
          installmentSchedule: [
            {
              number: 1,
              dueDate: "2025-02-01",
              amountMinorUnits: "100",
              status: "UNPAID",
              currency: "GHS",
            },
          ],
        },
      },
      {
        suffix: "paid-status",
        code: "INSTALLMENT_PAID_AMOUNT_MISMATCH",
        overrides: {
          installmentSchedule: [
            {
              number: 1,
              dueDate: "2025-02-01",
              amountMinorUnits: "100",
              paidAmountMinorUnits: "50",
              status: "PAID",
              currency: "GHS",
            },
          ],
        },
      },
      {
        suffix: "schedule-paid-net",
        code: "INSTALLMENT_PAID_TOTAL_MISMATCH",
        overrides: {
          installmentSchedule: [
            {
              number: 1,
              dueDate: "2025-02-01",
              amountMinorUnits: "50",
              paidAmountMinorUnits: "10",
              status: "PARTIAL",
              currency: "GHS",
            },
            {
              number: 2,
              dueDate: "2025-03-01",
              amountMinorUnits: "50",
              status: "UNPAID",
              currency: "GHS",
            },
          ],
        },
      },
    ];
    for (const [index, item] of cases.entries()) {
      const row = financialRow(item.suffix, item.overrides);
      const batch = await service.importBatch({
        actor,
        requestId: randomUUID(),
        source: "LEGACY_EXCEL",
        sourceBatchId: `financial-${item.suffix}`,
        sourceFileHash: ["6", "7", "8", "9", "a", "b", "c", "d", "e", "f"][
          index
        ]!.repeat(64),
        templateVersion: "legacy-v1",
        expectedRecords: 1,
        controlTotalMinorUnits: row.currentBalanceMinorUnits,
        rows: [row],
      });
      expect(batch.status).toBe("QUARANTINED");
      expect(batch.records[0]?.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: item.code })]),
      );
    }
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
            legacyId: "LEGACY-APP-1",
            fullName: "Applicant One",
            phoneE164: "+233200000002",
            ghanaCardFingerprint: "e".repeat(64),
            dateOfBirth: "1990-01-01",
          },
          guarantor: {
            legacyId: "LEGACY-GUA-1",
            fullName: "Guarantor One",
            phoneE164: "+233200000003",
            ghanaCardFingerprint: "d".repeat(64),
            dateOfBirth: "1985-01-01",
          },
          contract: {
            legacyId: "LEGACY-CONTRACT-1",
            reference: "LEGACY-CONTRACT-1",
            startDate: "2025-01-01",
            endDate: "2026-01-01",
            totalMinorUnits: "100",
            principalMinorUnits: "100",
            openingBalanceMinorUnits: "100",
          },
          vehicle: {
            legacyId: "LEGACY-VEHICLE-1",
            vin: "LEGACY-VIN-1",
            model: "Somoco Model One",
          },
          repaymentFrequency: "MONTHLY",
          tenureMonths: 12,
          arrearsMinorUnits: "0",
          arrearsAsOfDate: "2025-01-15",
          totalPaidMinorUnits: "0",
          repaymentHistory: [],
          installmentSchedule: monthlySchedule(),
          currentBalanceMinorUnits: "100",
          attachmentDocumentId: documentId,
        },
      ],
    });
    expect(batch.status).toBe("VALIDATED");
    await expect(
      service.verifyBatch({
        batchId: batch.id,
        actor: verifier,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("MIGRATION_SAMPLE_REQUIRED");
    await expect(
      service.verifyBatch({
        batchId: batch.id,
        actor: verifier,
        requestId: randomUUID(),
        sampleRecordIds: [],
      }),
    ).rejects.toThrow("MIGRATION_SAMPLE_REQUIRED");
    await service.verifyBatch({
      batchId: batch.id,
      actor: verifier,
      requestId: randomUUID(),
      sampleRecordIds: [batch.records[0]!.id],
    });
    await service.approveBatch({
      batchId: batch.id,
      actor: finance,
      requestId: randomUUID(),
      financialEvidenceHash: "1".repeat(64),
    });
    await expect(
      service.activateBatch({
        batchId: batch.id,
        actor: finance,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("MIGRATION_COMPLETE_GRAPH_REQUIRED");
    const quarantined = (await service.listBatches(finance)).find(
      (item) => item.id === batch.id,
    );
    expect(quarantined).toMatchObject({ status: "QUARANTINED" });
    expect(quarantined?.records[0]).toMatchObject({
      status: "VALID",
      targetId: null,
    });
    const target = await getInternalDatabase(database).execute<{
      status: string;
    }>(sql`
      select a.status
        from application a
        join migration_record r on r.target_id = a.id
       where r.migration_batch_id = ${batch.id}
    `);
    expect(target.rows).toEqual([]);
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

function monthlySchedule(): readonly Record<string, unknown>[] {
  const dates = [
    "2025-02-01",
    "2025-03-01",
    "2025-04-01",
    "2025-05-01",
    "2025-06-01",
    "2025-07-01",
    "2025-08-01",
    "2025-09-01",
    "2025-10-01",
    "2025-11-01",
    "2025-12-01",
    "2026-01-01",
  ];
  return dates.map((dueDate, index) => ({
    number: index + 1,
    dueDate,
    amountMinorUnits: index === dates.length - 1 ? "12" : "8",
    status: "UNPAID",
    currency: "GHS",
  }));
}

function financialRow(
  suffix: string,
  overrides: Record<string, unknown> = {},
): LegacyImportRow {
  const base = {
    sourceRecordId: `financial-${suffix}`,
    sourceRowNumber: 1,
    customer: {
      legacyId: `FIN-APP-${suffix}`,
      fullName: "Financial Applicant",
      phoneE164: "+233200000091",
      ghanaCardFingerprint: "8".repeat(64),
      dateOfBirth: "1990-01-01",
    },
    guarantor: {
      legacyId: `FIN-GUA-${suffix}`,
      fullName: "Financial Guarantor",
      phoneE164: "+233200000092",
      ghanaCardFingerprint: "9".repeat(64),
      dateOfBirth: "1985-01-01",
    },
    contract: {
      legacyId: `FIN-CON-${suffix}`,
      reference: `FIN-REF-${suffix}`,
      startDate: "2025-01-01",
      endDate: "2026-01-01",
      totalMinorUnits: "100",
      principalMinorUnits: "100",
      openingBalanceMinorUnits: "100",
    },
    vehicle: {
      legacyId: `FIN-VIN-${suffix}`,
      vin: `FIN-VIN-${suffix}`,
      model: "Somoco Model One",
    },
    repaymentFrequency: "MONTHLY",
    tenureMonths: 12,
    arrearsMinorUnits: "0",
    arrearsAsOfDate: "2025-01-15",
    totalPaidMinorUnits: "0",
    repaymentHistory: [],
    installmentSchedule: monthlySchedule(),
    currentBalanceMinorUnits: "100",
  };
  const overrideContract = overrides.contract;
  return {
    ...base,
    ...overrides,
    contract: {
      ...base.contract,
      ...(typeof overrideContract === "object" && overrideContract !== null
        ? overrideContract
        : {}),
    },
  } as unknown as LegacyImportRow;
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

async function createApprovedBoundBatch(
  database: Database,
  service: MigrationService,
  suffix: string,
  skipVerification = false,
): Promise<{
  batch: Awaited<ReturnType<MigrationService["importBatch"]>>;
  finance: StaffPrincipal;
  applicantFingerprint: string;
}> {
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
    values (${documentOwnerId}, '+233200000078')
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
       ${`accepted/${documentId}`}, 'v1', 'etag-live', ${"1".repeat(64)}, 'ACCEPTED', true)
  `);
  const applicantFingerprint = "5".repeat(64);
  const batch = await service.importBatch({
    actor: importer,
    requestId: randomUUID(),
    source: "LEGACY_PAPER",
    sourceBatchId: `approved-${suffix}`,
    sourceFileHash: "4".repeat(64),
    templateVersion: "legacy-v1",
    expectedRecords: 1,
    controlTotalMinorUnits: "100",
    rows: [
      {
        sourceRecordId: `approved-${suffix}-row`,
        sourceRowNumber: 1,
        customer: {
          legacyId: `LEGACY-APP-${suffix}`,
          fullName: "Applicant One",
          phoneE164: "+233200000079",
          ghanaCardFingerprint: applicantFingerprint,
          dateOfBirth: "1990-01-01",
        },
        guarantor: {
          legacyId: `LEGACY-GUA-${suffix}`,
          fullName: "Guarantor One",
          phoneE164: "+233200000080",
          ghanaCardFingerprint: "3".repeat(64),
          dateOfBirth: "1985-01-01",
        },
        contract: {
          legacyId: `LEGACY-CONTRACT-${suffix}`,
          reference: `APPROVED-${suffix}`,
          startDate: "2025-01-01",
          endDate: "2026-01-01",
          totalMinorUnits: "100",
          principalMinorUnits: "100",
          openingBalanceMinorUnits: "100",
        },
        vehicle: {
          legacyId: `LEGACY-VEHICLE-${suffix}`,
          vin: `VIN-${suffix}`,
          model: "Somoco Model One",
        },
        repaymentFrequency: "MONTHLY",
        tenureMonths: 12,
        arrearsMinorUnits: "0",
        arrearsAsOfDate: "2025-01-15",
        totalPaidMinorUnits: "0",
        repaymentHistory: [],
        installmentSchedule: monthlySchedule(),
        currentBalanceMinorUnits: "100",
        attachmentDocumentId: documentId,
      },
    ],
  });
  if (skipVerification) return { batch, finance, applicantFingerprint };
  await service.verifyBatch({
    batchId: batch.id,
    actor: verifier,
    requestId: randomUUID(),
    sampleRecordIds: [batch.records[0]!.id],
  });
  await service.approveBatch({
    batchId: batch.id,
    actor: finance,
    requestId: randomUUID(),
    financialEvidenceHash: "2".repeat(64),
  });
  return { batch, finance, applicantFingerprint };
}
