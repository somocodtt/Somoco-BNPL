import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deriveOtpCode, otpDerivationKeyId } from "@somo/integrations";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  paymentRepo,
  withTransaction,
  type Database,
} from "@somo/db";
import {
  ALLOCATION_POLICY_BEHAVIOR_DIGEST,
  ALLOCATION_POLICY_EXECUTION_KEY,
  ALLOCATION_POLICY_VERSION,
  hashAllocationEvidenceArtifact,
} from "../src/modules/payments/ledger-service.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import type { OtpPolicy } from "../src/modules/identity/otp-service.js";
import { createCollectionsService } from "../src/modules/collections/service.js";
import { createNotificationService } from "../src/modules/notifications/service.js";
import { createSettlementService } from "../src/modules/contracts/settlement-service.js";
import type {
  StaffPrincipal,
  StaffRole,
} from "../src/modules/access/policy.js";
import {
  executeTestSql,
  queryTestSql,
  resetTestDatabase,
} from "../../../packages/testkit/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL!;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl,
  allowedOrigins: ["https://staff.test.somo.example"],
  cookieName: "somo_staff_session",
  cookieSecret: "test-cookie-secret-with-at-least-32-characters",
  auditTargetHmacSecret: "test-audit-target-secret-with-at-least-32-characters",
  cookieSecure: false,
  bodyLimitBytes: 100_000,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};

const otpPolicy: OtpPolicy = {
  ttlMs: 120_000,
  attemptLimit: 3,
  resendCooldownMs: 30_000,
  codeLength: 6,
  hashSecret: "test-otp-hash-secret-with-at-least-32-characters",
  deliveryDerivationSecret:
    "test-otp-delivery-secret-with-at-least-32-characters",
  deliveryDerivationKeyId: otpDerivationKeyId(
    "test-otp-delivery-secret-with-at-least-32-characters",
  ),
  sessionTtlMs: 3_600_000,
};

let database: Database;
let closeDatabase: () => Promise<void>;

beforeAll(() => {
  const connection = createDatabase(databaseUrl);
  database = connection.db;
  closeDatabase = connection.close;
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl);
  await migrateDatabase(database);
});

afterAll(async () => {
  await closeDatabase();
});

describe("collections hardening against actor and contract scope", () => {
  it("requires a collections actor, rejects settled contracts, and replays one reminder", async () => {
    const fixture = await seedContract("ACTIVE", 100_000);
    const officer = await seedStaff("RECOVERY_OFFICER");
    const support = await seedStaff("CUSTOMER_SUPPORT");
    const notifications = createNotificationService({
      database,
      accountLinkBaseUrl: "https://customer.test.somo.example/account",
      ussdInstructions: "Dial *123# to pay.",
    });
    const queueReminder = notifications.queueReminder as unknown as (input: {
      contractId: string;
      template: "ARREARS_WARNING";
      idempotencyKey: string;
      asOfDate: string;
      overdueMinorUnits: bigint;
      actor: StaffPrincipal;
    }) => Promise<{ id: string; status: "QUEUED"; idempotencyKey: string }>;
    const input = {
      contractId: fixture.contractId,
      template: "ARREARS_WARNING" as const,
      idempotencyKey: "reminder-hardening-1",
      asOfDate: "2026-08-22",
      overdueMinorUnits: 100n,
      actor: principal(officer, "RECOVERY_OFFICER"),
    };

    const first = await queueReminder(input);
    const replay = await queueReminder(input);
    expect(replay).toEqual(first);
    const beforeConflict = await queryTestSql<{
      notification_count: number;
      outbox_count: number;
      audit_count: number;
    }>(
      databaseUrl,
      `select
         (select count(*)::int from notification) as notification_count,
         (select count(*)::int from outbox_message) as outbox_count,
         (select count(*)::int from audit_event) as audit_count`,
    );
    await expect(
      queueReminder({ ...input, overdueMinorUnits: 101n }),
    ).rejects.toMatchObject({ code: "REMINDER_IDEMPOTENCY_KEY_REUSED" });
    await expect(
      queryTestSql<{
        notification_count: number;
        outbox_count: number;
        audit_count: number;
      }>(
        databaseUrl,
        `select
           (select count(*)::int from notification) as notification_count,
           (select count(*)::int from outbox_message) as outbox_count,
           (select count(*)::int from audit_event) as audit_count`,
      ),
    ).resolves.toEqual(beforeConflict);
    expect(
      await queryTestSql<{ count: number }>(
        databaseUrl,
        "select count(*)::int as count from audit_event where action = 'REMINDER_QUEUED'",
        [],
      ),
    ).toEqual({ count: 1 });

    await expect(
      queueReminder({
        ...input,
        idempotencyKey: "reminder-support-1",
        actor: principal(support, "CUSTOMER_SUPPORT"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await queryTestSql<{ count: number }>(
        databaseUrl,
        "select count(*)::int as count from audit_event where action = 'REMINDER_DENIED'",
        [],
      ),
    ).toEqual({ count: 1 });

    const auditor = await seedStaff("COMPLIANCE_AUDITOR");
    await expect(
      queueReminder({
        ...input,
        idempotencyKey: "reminder-auditor-1",
        actor: principal(auditor, "COMPLIANCE_AUDITOR"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await executeTestSql(
      databaseUrl,
      "update contract set status = 'SETTLED' where id = $1",
      [fixture.contractId],
    );
    await expect(
      queueReminder({
        ...input,
        idempotencyKey: "reminder-settled-1",
      }),
    ).rejects.toMatchObject({ code: "CONTRACT_NOT_ELIGIBLE" });
  });
});

describe("settlement aggregate concurrency", () => {
  it("does not let one dual-role actor approve finance and business concurrently", async () => {
    const fixture = await seedContract("ACTIVE", 100_000);
    const actorId = await seedStaff("CFO", "MD");
    const actor = principal(actorId, "CFO", "MD");
    const settlement = createSettlementService({ database });

    const results = await Promise.allSettled([
      settlement.approveFinance({
        contractId: fixture.contractId,
        reason: "Finance reconciliation",
        idempotencyKey: "finance-concurrency-1",
        actor,
      }),
      settlement.approveBusiness({
        contractId: fixture.contractId,
        reason: "Business ownership transfer",
        idempotencyKey: "business-concurrency-1",
        actor,
      }),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(rejected?.reason).toMatchObject({
      code: "SETTLEMENT_APPROVER_SEPARATION_REQUIRED",
    });
  });
});

describe("settlement transfer evidence", () => {
  it("resolves clean accepted evidence from the applicant-bound privacy document", async () => {
    const fixture = await seedContract("ACTIVE", 0);
    const actorId = await seedStaff("MD");
    const documentId = await seedCleanDocument(fixture.applicantId);
    const settlement = createSettlementService({ database });
    const recordEvidence = settlement.recordEvidence as unknown as (input: {
      contractId: string;
      evidenceDocumentId: string;
      actor: StaffPrincipal;
    }) => Promise<Record<string, unknown>>;

    const result = await recordEvidence({
      contractId: fixture.contractId,
      evidenceDocumentId: documentId,
      actor: principal(actorId, "MD"),
    });
    expect(result).toMatchObject({
      contractId: fixture.contractId,
      evidenceDocumentId: documentId,
      evidenceHash: "b".repeat(64),
      verificationStatus: "CLEAN",
    });
  });

  it("rejects a legacy unbound CLEAN conflict instead of replaying it", async () => {
    const fixture = await seedContract("ACTIVE", 0);
    const actorId = await seedStaff("MD");
    const documentId = await seedCleanDocument(fixture.applicantId);
    await executeTestSql(
      databaseUrl,
      `insert into settlement_evidence
        (id, contract_id, evidence_document_id, evidence_document_reference,
         evidence_hash, evidence_object_key, evidence_object_version_id,
         evidence_object_etag, verification_status, accepted_by, accepted_at)
       values ($1, $2, $3, 'legacy/mismatched.pdf', repeat('a', 64),
               'legacy/mismatched.pdf', 'legacy-v0', 'legacy-etag', 'CLEAN', $4, now())`,
      [randomUUID(), fixture.contractId, documentId, actorId],
    );
    const settlement = createSettlementService({ database });
    const recordEvidence = settlement.recordEvidence as unknown as (input: {
      contractId: string;
      evidenceDocumentId: string;
      actor: StaffPrincipal;
    }) => Promise<Record<string, unknown>>;

    await expect(
      recordEvidence({
        contractId: fixture.contractId,
        evidenceDocumentId: documentId,
        actor: principal(actorId, "MD"),
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_EVIDENCE_BINDING_CONFLICT" });
  });
});

describe("recovery action replay", () => {
  it("persists one action for a concurrent replay and rejects a mismatched payload", async () => {
    const fixture = await seedContract("ACTIVE", 100_000);
    const maker = await seedStaff("RECOVERY_OFFICER");
    const checker = await seedStaff("RECOVERY_OFFICER");
    const recoveryCaseId = randomUUID();
    await executeTestSql(
      databaseUrl,
      `insert into recovery_case (id, contract_id, status, details, opened_at)
       values ($1, $2, 'OPEN', $3::jsonb, now())`,
      [
        recoveryCaseId,
        fixture.contractId,
        JSON.stringify({ openedByStaffUserId: maker }),
      ],
    );
    await executeTestSql(
      databaseUrl,
      `insert into recovery_decision
        (id, recovery_case_id, idempotency_key, maker_staff_user_id,
         checker_staff_user_id, decision, purpose, reason, decided_at)
       values ($1, $2, $3, $4, $5, 'APPROVED', 'Recovery', 'Approved', now())`,
      [randomUUID(), recoveryCaseId, "decision-for-action-1", maker, checker],
    );
    const collections = createCollectionsService({ database });
    const recordAction = collections.recordAction as unknown as (input: {
      recoveryCaseId: string;
      actionType: "MANUAL_RECOVERY";
      purpose: string;
      requestedBy: string;
      evidence: Record<string, unknown>;
      evidenceHash: string;
      idempotencyKey: string;
      authorizedBy: StaffPrincipal;
    }) => Promise<Record<string, unknown>>;
    const input = {
      recoveryCaseId,
      actionType: "MANUAL_RECOVERY" as const,
      purpose: "Human recovery visit",
      requestedBy: maker,
      evidence: { note: "field review" },
      evidenceHash: "a".repeat(64),
      idempotencyKey: "recovery-action-replay-1",
      authorizedBy: principal(checker, "RECOVERY_OFFICER"),
    };

    const [first, replay] = await Promise.all([
      recordAction(input),
      recordAction(input),
    ]);
    expect(replay.id).toBe(first.id);
    await expect(
      recordAction({ ...input, evidenceHash: "c".repeat(64) }),
    ).rejects.toMatchObject({ code: "RECOVERY_IDEMPOTENCY_KEY_REUSED" });
    expect(
      await queryTestSql<{ count: number }>(
        databaseUrl,
        "select count(*)::int as count from recovery_action where recovery_case_id = $1",
        [recoveryCaseId],
      ),
    ).toEqual({ count: 1 });
  });
});

describe("settlement and reconciliation serialization", () => {
  it("waits for an unresolved reconciliation insert before deciding settlement", async () => {
    const fixture = await seedContract("ACTIVE", 0);
    const finance = await seedStaff("CFO");
    const business = await seedStaff("MD");
    const evidence = randomUUID();
    const evidenceDocumentId = await seedCleanDocument(fixture.applicantId);
    await executeTestSql(
      databaseUrl,
      `insert into settlement_approval
        (id, contract_id, approval_type, idempotency_key, approved_by, reason, approved_at)
       values ($1, $2, 'FINANCE_RECONCILIATION', $3, $4, 'Finance', now()),
              ($5, $2, 'BUSINESS_OWNERSHIP_TRANSFER', $6, $7, 'Business', now())`,
      [
        randomUUID(),
        fixture.contractId,
        "gate-finance-1",
        finance,
        randomUUID(),
        "gate-business-1",
        business,
      ],
    );
    await executeTestSql(
      databaseUrl,
      `insert into settlement_evidence
        (id, contract_id, evidence_document_id, evidence_document_reference,
         evidence_hash, evidence_object_key, evidence_object_version_id,
         evidence_object_etag, verification_status, accepted_by, accepted_at)
       values ($1, $2, $3, $4, repeat('b', 64), $4, 'v1', 'etag', 'CLEAN', $5, now())`,
      [
        evidence,
        fixture.contractId,
        evidenceDocumentId,
        `accepted/${evidenceDocumentId}`,
        business,
      ],
    );

    let inserted = false;
    let releaseInsert!: () => void;
    const insertReleased = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    const insertion = withTransaction(database, async (tx) => {
      await paymentRepo(tx).createReconciliationCase({
        reason: "UNMATCHED_SETTLEMENT_TEST",
        dedupeKey: "unmatched-settlement-test-1",
      });
      inserted = true;
      await insertReleased;
    });
    while (!inserted) await new Promise((resolve) => setTimeout(resolve, 5));

    let settled = false;
    const settlement = createSettlementService({ database });
    const pending = settlement
      .settle({
        contractId: fixture.contractId,
        actor: principal(finance, "CFO"),
      })
      .then(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    releaseInsert();
    await insertion;
    await expect(pending).rejects.toMatchObject({
      code: "SETTLEMENT_RECONCILIATION_INCOMPLETE",
    });
  });
});

describe("collections HTTP authorization", () => {
  it("enforces CSRF and collections roles on reminder POST", async () => {
    const fixture = await seedContract("ACTIVE", 100_000);
    const support = await seedHttpStaff("CUSTOMER_SUPPORT");
    const officer = await seedHttpStaff("RECOVERY_OFFICER");
    const auditor = await seedHttpStaff("COMPLIANCE_AUDITOR");
    const maker = await seedHttpStaff("RECOVERY_OFFICER");
    const md = await seedHttpStaff("MD");
    const transferDocumentId = await seedCleanDocument(fixture.applicantId);
    const app = await buildApp({
      config,
      database,
      logger: false,
      mfaVerifier: {
        kind: "test",
        async verify({ assertion }) {
          return assertion === "valid";
        },
      },
      payments: {
        verifier: {
          async verify() {
            throw new Error("unused");
          },
        },
        allocationPolicy: {
          version: ALLOCATION_POLICY_VERSION,
          executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
          behaviorDigest: ALLOCATION_POLICY_BEHAVIOR_DIGEST,
          evidence: {
            artifact: { test: true },
            evidenceHash: hashAllocationEvidenceArtifact({ test: true }),
            financeApprovedBy: "finance",
            complianceApprovedBy: "compliance",
            financeSignature: "finance-signature",
            complianceSignature: "compliance-signature",
            financeApprovedAt: "2026-08-01T00:00:00.000Z",
            complianceApprovedAt: "2026-08-01T00:00:00.000Z",
          },
        },
        sms: {
          async send() {
            return {
              providerReference: randomUUID(),
              acceptedAt: new Date().toISOString(),
            };
          },
        },
        accountLinkBaseUrl: "https://customer.test.somo.example/account",
        ussdInstructions: "Dial *123# to pay.",
      },
      identity: {
        sms: {
          async send() {
            return {
              providerReference: "test-customer-otp",
              acceptedAt: "2026-08-22T00:00:00.000Z",
            };
          },
        },
        otpPolicy,
        consentCatalog: {
          documents: [
            {
              purpose: "NIA_IDENTITY_VERIFICATION",
              currentVersion: "nia-consent-v1",
            },
          ],
        },
      },
    });
    try {
      const supportLogin = await login(app, support.email);
      const denied = await app.inject({
        method: "POST",
        url: "/v1/staff/collections/reminders",
        headers: {
          cookie: supportLogin.cookie,
          "x-csrf-token": supportLogin.csrf,
        },
        payload: reminderPayload(fixture.contractId, "http-reminder-support"),
      });
      expect(denied.statusCode).toBe(403);

      const auditorLogin = await login(app, auditor.email);
      const auditorDenied = await app.inject({
        method: "POST",
        url: "/v1/staff/collections/reminders",
        headers: {
          cookie: auditorLogin.cookie,
          "x-csrf-token": auditorLogin.csrf,
        },
        payload: reminderPayload(fixture.contractId, "http-reminder-auditor"),
      });
      expect(auditorDenied.statusCode).toBe(403);

      const officerLogin = await login(app, officer.email);
      const missingCsrf = await app.inject({
        method: "POST",
        url: "/v1/staff/collections/reminders",
        headers: { cookie: officerLogin.cookie },
        payload: reminderPayload(fixture.contractId, "http-reminder-csrf"),
      });
      expect(missingCsrf.statusCode).toBe(403);

      const missingActionKey = await app.inject({
        method: "POST",
        url: `/v1/staff/collections/cases/${randomUUID()}/actions`,
        headers: {
          cookie: officerLogin.cookie,
          "x-csrf-token": officerLogin.csrf,
        },
        payload: {
          actionType: "VISIT",
          purpose: "Review",
          requestedBy: randomUUID(),
          evidence: {},
          evidenceHash: "a".repeat(64),
        },
      });
      expect(missingActionKey.statusCode).toBe(400);

      const callerDeclaredEvidence = await app.inject({
        method: "POST",
        url: `/v1/staff/contracts/${fixture.contractId}/settlement/evidence`,
        headers: {
          cookie: officerLogin.cookie,
          "x-csrf-token": officerLogin.csrf,
        },
        payload: {
          evidenceDocumentReference: "accepted/fake.pdf",
          evidenceHash: "b".repeat(64),
          verificationStatus: "CLEAN",
        },
      });
      expect(callerDeclaredEvidence.statusCode).toBe(400);

      const allowed = await app.inject({
        method: "POST",
        url: "/v1/staff/collections/reminders",
        headers: {
          cookie: officerLogin.cookie,
          "x-csrf-token": officerLogin.csrf,
        },
        payload: reminderPayload(fixture.contractId, "http-reminder-allowed"),
      });
      expect(allowed.statusCode).toBe(201);

      const changed = await app.inject({
        method: "POST",
        url: "/v1/staff/collections/reminders",
        headers: {
          cookie: officerLogin.cookie,
          "x-csrf-token": officerLogin.csrf,
        },
        payload: {
          ...reminderPayload(fixture.contractId, "http-reminder-allowed"),
          overdueMinorUnits: "101",
        },
      });
      expect(changed.statusCode).toBe(409);

      const recoveryCaseId = randomUUID();
      await executeTestSql(
        databaseUrl,
        `insert into recovery_case (id, contract_id, status, details, opened_at)
         values ($1, $2, 'OPEN', $3::jsonb, now())`,
        [
          recoveryCaseId,
          fixture.contractId,
          JSON.stringify({ openedByStaffUserId: maker.id }),
        ],
      );
      await executeTestSql(
        databaseUrl,
        `insert into recovery_decision
          (id, recovery_case_id, idempotency_key, maker_staff_user_id,
           checker_staff_user_id, decision, purpose, reason, decided_at)
         values ($1, $2, $3, $4, $5, 'APPROVED', 'HTTP', 'Approved', now())`,
        [
          randomUUID(),
          recoveryCaseId,
          `http-decision-${randomUUID()}`,
          maker.id,
          officer.id,
        ],
      );
      const actionPayload = {
        actionType: "VISIT",
        purpose: "HTTP review",
        requestedBy: maker.id,
        evidence: { note: "same action" },
        evidenceHash: "a".repeat(64),
        idempotencyKey: "http-action-replay-1",
      } as const;
      const action = await app.inject({
        method: "POST",
        url: `/v1/staff/collections/cases/${recoveryCaseId}/actions`,
        headers: {
          cookie: officerLogin.cookie,
          "x-csrf-token": officerLogin.csrf,
        },
        payload: actionPayload,
      });
      expect(action.statusCode).toBe(201);
      const actionReplay = await app.inject({
        method: "POST",
        url: `/v1/staff/collections/cases/${recoveryCaseId}/actions`,
        headers: {
          cookie: officerLogin.cookie,
          "x-csrf-token": officerLogin.csrf,
        },
        payload: actionPayload,
      });
      expect(actionReplay.statusCode).toBe(201);
      expect(actionReplay.json<{ id: string }>().id).toBe(
        action.json<{ id: string }>().id,
      );

      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/staff/collections/arrears",
            headers: { cookie: officerLogin.cookie },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/staff/collections/cases",
            headers: { cookie: officerLogin.cookie },
          })
        ).statusCode,
      ).toBe(200);

      const officerEvidenceDenied = await app.inject({
        method: "POST",
        url: `/v1/staff/contracts/${fixture.contractId}/settlement/evidence`,
        headers: {
          cookie: officerLogin.cookie,
          "x-csrf-token": officerLogin.csrf,
        },
        payload: { evidenceDocumentId: transferDocumentId },
      });
      expect(officerEvidenceDenied.statusCode).toBe(403);
      const mdLogin = await login(app, md.email);
      const mdEvidenceAccepted = await app.inject({
        method: "POST",
        url: `/v1/staff/contracts/${fixture.contractId}/settlement/evidence`,
        headers: { cookie: mdLogin.cookie, "x-csrf-token": mdLogin.csrf },
        payload: { evidenceDocumentId: transferDocumentId },
      });
      expect(mdEvidenceAccepted.statusCode).toBe(200);

      await executeTestSql(
        databaseUrl,
        "update privacy.person set phone_e164 = '+233201234567' where id = $1",
        [fixture.applicantId],
      );
      const person = await queryTestSql<{ phone_e164: string }>(
        databaseUrl,
        "select phone_e164 from privacy.person where id = $1",
        [fixture.applicantId],
      );
      const otpRequested = await app.inject({
        method: "POST",
        url: "/v1/customer/otp/requests",
        payload: { phoneE164: person.phone_e164 },
      });
      expect(otpRequested.statusCode, otpRequested.body).toBe(202);
      const challenge = await queryTestSql<{ id: string }>(
        databaseUrl,
        `select id from privacy.otp_challenge
          where person_id = $1 order by created_at desc limit 1`,
        [fixture.applicantId],
      );
      const otpVerified = await app.inject({
        method: "POST",
        url: "/v1/customer/otp/verifications",
        payload: {
          phoneE164: person.phone_e164,
          code: deriveOtpCode(
            otpPolicy.deliveryDerivationSecret,
            challenge.id,
            otpPolicy.codeLength,
          ),
        },
      });
      expect(otpVerified.statusCode).toBe(201);
      const customerToken = otpVerified.json<{ sessionToken: string }>();
      const customerStatus = await app.inject({
        method: "GET",
        url: "/v1/customer/account-status",
        headers: { authorization: `Bearer ${customerToken.sessionToken}` },
      });
      expect(customerStatus.statusCode).toBe(200);
      expect(
        customerStatus.json<ReadonlyArray<{ contractId: string }>>(),
      ).toEqual([expect.objectContaining({ contractId: fixture.contractId })]);
    } finally {
      await app.close();
    }
  });
});

function reminderPayload(contractId: string, idempotencyKey: string) {
  return {
    contractId,
    template: "ARREARS_WARNING",
    idempotencyKey,
    asOfDate: "2026-08-22",
    overdueMinorUnits: "100",
  };
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string,
): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/staff/sessions",
    payload: {
      email,
      password: "correct horse battery staple",
      mfaAssertion: "valid",
    },
  });
  const setCookies = (
    Array.isArray(response.headers["set-cookie"])
      ? response.headers["set-cookie"]
      : [response.headers["set-cookie"]]
  ).filter((value): value is string => typeof value === "string");
  return {
    cookie: setCookies.map((value) => value.split(";", 1)[0]).join("; "),
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
}

function principal(staffUserId: string, ...roles: StaffRole[]): StaffPrincipal {
  return { kind: "staff", staffUserId, roles, sessionId: randomUUID() };
}

async function seedStaff(...roles: StaffRole[]): Promise<string> {
  const id = randomUUID();
  await executeTestSql(
    databaseUrl,
    "insert into staff_user (id, email, password_hash) values ($1, $2, $3)",
    [id, `${id}@example.test`, "test-password-hash"],
  );
  for (const role of roles)
    await executeTestSql(
      databaseUrl,
      "insert into staff_role_assignment (staff_user_id, role) values ($1, $2)",
      [id, role],
    );
  return id;
}

async function seedHttpStaff(role: StaffRole) {
  return createStaffUser(database, {
    email: `${role}-${randomUUID()}@example.test`,
    passwordHash: await argon2.hash("correct horse battery staple", {
      type: argon2.argon2id,
      memoryCost: config.argon2MemoryCostKiB,
      timeCost: config.argon2TimeCost,
      parallelism: config.argon2Parallelism,
    }),
    roles: [role],
  });
}

async function seedCleanDocument(personId: string): Promise<string> {
  const id = randomUUID();
  await executeTestSql(
    databaseUrl,
    `insert into privacy.document
      (id, person_id, document_type, object_key, declared_mime_type, declared_size_bytes,
       upload_ticket_hash, upload_expires_at, accepted_object_key, accepted_object_version_id,
       accepted_object_etag, sha256, status, malware_scanned)
     values ($1, $2, 'TRANSFER_EVIDENCE', $3, 'application/pdf', 128,
       repeat('a', 64), now() + interval '5 minutes', $4, 'v1', 'etag',
       repeat('b', 64), 'ACCEPTED', true)`,
    [id, personId, `pending/${id}`, `accepted/${id}`],
  );
  return id;
}

async function seedContract(
  status: "ACTIVE" | "SETTLED",
  balance: number,
): Promise<{ contractId: string; applicantId: string }> {
  const suffix = randomUUID();
  const applicantId = randomUUID();
  const applicationId = randomUUID();
  const modelId = randomUUID();
  const productId = randomUUID();
  const ruleId = randomUUID();
  const offerId = randomUUID();
  const offerVersionId = randomUUID();
  const vehicleId = randomUUID();
  const contractId = randomUUID();
  await executeTestSql(
    databaseUrl,
    "insert into privacy.person (id, phone_e164) values ($1, $2)",
    [applicantId, `+23320${suffix.replaceAll("-", "").slice(0, 8)}`],
  );
  await executeTestSql(
    databaseUrl,
    "insert into application (id, applicant_person_id, status) values ($1, $2, 'APPROVED')",
    [applicationId, applicantId],
  );
  await executeTestSql(
    databaseUrl,
    "insert into vehicle_model (id, manufacturer, model_name, model_year, active) values ($1, 'Somo', 'Pilot', 2026, true)",
    [modelId],
  );
  await executeTestSql(
    databaseUrl,
    "insert into product (id, code, name, vehicle_model_id) values ($1, $2, 'Pilot', $3)",
    [productId, `P-${suffix}`, modelId],
  );
  await executeTestSql(
    databaseUrl,
    `insert into financing_rule_version
      (id, product_id, version_number, minimum_deposit_minor_units, annual_rate_bps,
       allowed_tenures_months, repayment_frequencies, calculation_method)
     values ($1, $2, 1, 10000, 0, '[12]'::jsonb, '["MONTHLY"]'::jsonb, 'FLAT_MARKUP')`,
    [ruleId, productId],
  );
  await executeTestSql(
    databaseUrl,
    "insert into offer (id, application_id) values ($1, $2)",
    [offerId, applicationId],
  );
  await executeTestSql(
    databaseUrl,
    `insert into offer_version
      (id, offer_id, financing_rule_version_id, version_number, principal_minor_units,
       deposit_minor_units, total_payable_minor_units, terms)
     values ($1, $2, $3, 1, 100000, 10000, 110000, '{}'::jsonb)`,
    [offerVersionId, offerId, ruleId],
  );
  await executeTestSql(
    databaseUrl,
    "insert into vehicle_unit (id, vehicle_model_id, vin, chassis_number) values ($1, $2, $3, $4)",
    [vehicleId, modelId, `VIN-${suffix}`, `CH-${suffix}`],
  );
  await executeTestSql(
    databaseUrl,
    `insert into contract
      (id, reference, application_id, offer_version_id, vehicle_unit_id, status,
       outstanding_balance_minor_units)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [
      contractId,
      `CONTRACT-${suffix}`,
      applicationId,
      offerVersionId,
      vehicleId,
      status,
      balance,
    ],
  );
  return { contractId, applicantId };
}
