import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, migrateDatabase, type Database } from "@somo/db";
import { resetTestDatabase } from "../../../packages/testkit/src/index.js";
import { getInternalDatabase } from "../../../packages/db/src/client.js";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import {
  createPostgresPrivacyService,
  createPrivacyService,
} from "../src/modules/privacy/service.js";

describe("privacy lifecycle", () => {
  it("keeps auditor and system admin read-only while officers perform privacy mutations", async () => {
    const service = createPrivacyService();
    const subjectId = "00000000-0000-4000-8000-000000000010";
    const request = await service.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "CORRECTION",
    });

    for (const role of ["COMPLIANCE_AUDITOR", "SYSTEM_ADMIN"]) {
      await expect(
        service.recordCorrection({
          requestId: request.id,
          subjectId,
          field: "displayName",
          proposedValue: "Denied mutation",
          reason: "Read-only role must not alter privacy evidence",
          actor: { id: `staff-${role}`, role },
        }),
      ).rejects.toMatchObject({
        code: "PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED",
      });
    }

    await expect(
      service.recordCorrection({
        requestId: request.id,
        subjectId,
        field: "displayName",
        proposedValue: "Approved correction",
        reason: "Verified correction request",
        actor: { id: "staff-compliance-officer", role: "COMPLIANCE_OFFICER" },
      }),
    ).resolves.toMatchObject({ field: "displayName", version: 1 });
    await expect(
      service.approveRetentionPolicy({
        version: "officer-retention-v1",
        retentionDays: 30,
        actor: { id: "staff-dpo", role: "DPO" },
      }),
    ).resolves.toMatchObject({ version: "officer-retention-v1" });
  });

  it("exports only the requesting subject's safe data", async () => {
    const service = createPrivacyService({
      subjectData: async (subjectId) => ({
        personId: subjectId,
        profile: { displayName: "Applicant", phoneE164: "+233240000001" },
        otp: "never-export-this",
      }),
    });
    const request = await service.openRequest({
      subjectId: "00000000-0000-4000-8000-000000000001",
      subjectType: "APPLICANT",
      requestType: "ACCESS",
    });

    await expect(
      service.exportSubjectData({
        requestId: request.id,
        subjectId: request.subjectId,
      }),
    ).resolves.toEqual({
      subjectId: request.subjectId,
      profile: { displayName: "Applicant", phoneE164: "+233240000001" },
      restrictions: [],
      corrections: [],
    });
  });

  it("records corrections as append-only amendments and refuses immutable evidence", async () => {
    const service = createPrivacyService();
    const subjectId = "00000000-0000-4000-8000-000000000002";
    const access = await service.openRequest({
      subjectId,
      subjectType: "GUARANTOR",
      requestType: "ACCESS",
    });
    const correctionRequest = await service.openRequest({
      subjectId,
      subjectType: "GUARANTOR",
      requestType: "CORRECTION",
    });
    const actor = { id: "staff-compliance", role: "COMPLIANCE_OFFICER" };
    await expect(
      service.recordCorrection({
        requestId: correctionRequest.id,
        subjectId,
        field: "paymentBalance",
        proposedValue: "0",
        reason: "Not a profile correction",
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRIVACY_IMMUTABLE_EVIDENCE" });
    const first = await service.recordCorrection({
      requestId: correctionRequest.id,
      subjectId,
      field: "displayName",
      proposedValue: "Corrected name",
      reason: "Applicant supplied corrected spelling",
      actor,
    });
    const second = await service.recordCorrection({
      requestId: correctionRequest.id,
      subjectId,
      field: "displayName",
      proposedValue: "Second corrected name",
      reason: "Applicant supplied a newer correction",
      actor,
    });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    await expect(
      service.exportSubjectData({ requestId: access.id, subjectId }),
    ).resolves.toMatchObject({
      corrections: [
        { field: "displayName", version: 1 },
        { field: "displayName", version: 2 },
      ],
    });
  });

  it("requires an approved retention policy and skips legal holds", async () => {
    const subjectId = "00000000-0000-4000-8000-000000000003";
    const heldSubjectId = "00000000-0000-4000-8000-000000000004";
    const service = createPrivacyService({
      subjectIds: [subjectId, heldSubjectId],
      now: () => new Date("2026-08-23T00:00:00.000Z"),
    });
    const actor = { id: "staff-compliance", role: "DPO" };
    await expect(
      service.applyRetention({
        policyVersion: "retention-v1",
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRIVACY_RETENTION_POLICY_NOT_APPROVED" });
    const correctionRequest = await service.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "CORRECTION",
    });
    await service.recordCorrection({
      requestId: correctionRequest.id,
      subjectId,
      field: "displayName",
      proposedValue: "Old name",
      reason: "Historical correction",
      actor,
    });
    await service.placeLegalHold({
      subjectId: heldSubjectId,
      reason: "Regulatory review",
      actor,
    });
    await service.approveRetentionPolicy({
      version: "retention-v1",
      retentionDays: 30,
      actor,
    });
    await expect(
      service.applyRetention({
        policyVersion: "retention-v1",
        asOf: new Date("2027-01-01T00:00:00.000Z"),
        actor,
      }),
    ).resolves.toEqual({
      policyVersion: "retention-v1",
      evaluated: 2,
      anonymized: 1,
      retained: 0,
      skippedLegalHold: 1,
      immutableEvidenceRetained: 2,
    });
  });
});

describe("durable PostgreSQL privacy lifecycle", () => {
  const databaseUrl = process.env.TEST_DATABASE_URL!;
  let database: Database;
  let closeDatabase: () => Promise<void>;

  beforeAll(() => {
    if (databaseUrl === undefined)
      throw new Error("TEST_DATABASE_URL is required");
    const connection = createDatabase(databaseUrl);
    database = connection.db;
    closeDatabase = connection.close;
  });

  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(database);
  }, 30_000);

  afterAll(async () => {
    await closeDatabase();
  });

  it("persists append-only request, correction, retention, and audit evidence across service instances", async () => {
    const subjectId = randomUUID();
    const officerId = randomUUID();
    const dpoId = randomUUID();
    const internal = getInternalDatabase(database);
    await internal.execute(sql`
      insert into privacy.person (id, phone_e164)
      values (${subjectId}, ${`+23320${subjectId.replaceAll("-", "").slice(0, 8)}`})
    `);
    await internal.execute(sql`
      insert into staff_user (id, email, password_hash)
      values (${officerId}, ${`${officerId}@example.test`}, 'test-hash'),
             (${dpoId}, ${`${dpoId}@example.test`}, 'test-hash')
    `);
    const now = () => new Date("2026-08-24T12:00:00.000Z");
    const subjectData = async () => ({
      profile: {
        displayName: "Persisted applicant",
        phoneE164: "+233200000001",
      },
      otp: "never-export",
    });
    const first = createPostgresPrivacyService({
      database,
      now,
      subjectData,
    });
    const correctionRequest = await first.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "CORRECTION",
      requestedBy: subjectId,
      reason: "Correct spelling",
    });
    await first.reviewRequest({
      requestId: correctionRequest.id,
      actor: { id: officerId, role: "COMPLIANCE_OFFICER" },
    });
    await first.recordCorrection({
      requestId: correctionRequest.id,
      subjectId,
      field: "displayName",
      proposedValue: "Corrected applicant",
      reason: "Verified identity document",
      actor: { id: officerId, role: "COMPLIANCE_OFFICER" },
    });
    await first.approveRetentionPolicy({
      version: "durable-retention-v1",
      retentionDays: 30,
      actor: { id: dpoId, role: "DPO" },
    });

    const second = createPostgresPrivacyService({
      database,
      now,
      subjectData,
    });
    await expect(
      second.listRequests({
        actor: { id: officerId, role: "COMPLIANCE_AUDITOR" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: correctionRequest.id,
        status: "IN_REVIEW",
      }),
    ]);
    const access = await second.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "ACCESS",
      requestedBy: subjectId,
    });
    await expect(
      second.exportSubjectData({ requestId: access.id, subjectId }),
    ).resolves.toMatchObject({
      profile: { displayName: "Persisted applicant" },
      corrections: [{ field: "displayName", version: 1 }],
    });
    await expect(
      second.applyRetention({
        policyVersion: "durable-retention-v1",
        asOf: new Date("2027-01-01T00:00:00.000Z"),
        actor: { id: dpoId, role: "DPO" },
      }),
    ).resolves.toMatchObject({ anonymized: 1, immutableEvidenceRetained: 1 });

    const third = createPostgresPrivacyService({
      database,
      now,
      subjectData,
    });
    await expect(
      third.exportSubjectData({ requestId: access.id, subjectId }),
    ).resolves.toMatchObject({ profile: { anonymized: true } });
    expect(
      (
        await internal.execute<{ count: number }>(sql`
          select count(*)::int as count from audit_event
           where aggregate_type like 'privacy_%'
        `)
      ).rows[0]?.count,
    ).toBeGreaterThanOrEqual(6);

    for (const statement of [
      sql`delete from privacy.privacy_request_evidence where id = ${correctionRequest.id}`,
      sql`update privacy.privacy_correction_evidence set reason = 'tampered' where request_id = ${correctionRequest.id}`,
      sql`update privacy.privacy_retention_policy_evidence set retention_days = 1 where version = 'durable-retention-v1'`,
      sql`delete from privacy.privacy_retention_run_evidence`,
    ]) {
      await expect(internal.execute(statement)).rejects.toThrow();
    }
  });
});
