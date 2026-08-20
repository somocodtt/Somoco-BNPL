import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type Database,
  type DatabaseStaffRole,
} from "@somo/db";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  executeTestSql,
  queryTestSql,
  readAuditEventsForAggregate,
  resetTestDatabase,
} from "../../../packages/testkit/src/index.js";
import type {
  CustomerPrincipal,
  StaffPrincipal,
  StaffRole,
} from "../src/modules/access/policy.js";
import { assertDecisionAllowed } from "../src/modules/approvals/policy.js";
import {
  createApprovalService,
  type ApprovalService,
} from "../src/modules/approvals/service.js";
import {
  createUnderwritingService,
  type UnderwritingService,
} from "../src/modules/approvals/underwriting-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required for API integration tests");
}

let database: Database;
let closeDatabase: () => Promise<void>;
let approvals: ApprovalService;
let underwriting: UnderwritingService;

beforeAll(() => {
  const connection = createDatabase(databaseUrl!);
  database = connection.db;
  closeDatabase = connection.close;
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl!);
  await migrateDatabase(database);
  approvals = createApprovalService({ database });
  underwriting = createUnderwritingService({ database });
});

afterAll(async () => {
  await closeDatabase();
});

describe("fixed approval workflow", () => {
  it("advances every stage in the server-owned sequence", async () => {
    const fixture = await seedSubmittedApplication();
    const chain = [
      ["VERIFICATION", "VERIFICATION_OFFICER", "BSM_INITIAL_REVIEW"],
      ["BSM_INITIAL", "BSM", "AGM_REVIEW"],
      ["AGM", "AGM", "CFO_REVIEW"],
      ["CFO", "CFO", "BSM_FINAL_REVIEW"],
      ["BSM_FINAL", "BSM", "MD_REVIEW"],
      ["MD", "MD", "APPROVED"],
    ] as const;
    let expectedVersion = 1;
    for (const [stage, role, expectedStatus] of chain) {
      const result = await approvals.approve({
        applicationId: fixture.applicationId,
        expectedVersion,
        stage,
        actor: staffPrincipal(fixture.staff[role], role),
        note: `${stage} approved`,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      });
      expect(result.status).toBe(expectedStatus);
      expectedVersion = result.version;
    }
    expect(await readApplication(fixture.applicationId)).toMatchObject({
      status: "APPROVED",
      version: 7,
    });
  });

  it("denies wrong roles and stage skipping without mutation", async () => {
    const fixture = await seedSubmittedApplication();
    await expect(
      approvals.approve({
        applicationId: fixture.applicationId,
        expectedVersion: 1,
        stage: "VERIFICATION",
        actor: staffPrincipal(fixture.staff.BSM, "BSM"),
        note: "wrong role",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      approvals.approve({
        applicationId: fixture.applicationId,
        expectedVersion: 1,
        stage: "AGM",
        actor: staffPrincipal(fixture.staff.AGM, "AGM"),
        note: "skip",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "APPROVAL_STAGE_MISMATCH" });
    expect(await readApplication(fixture.applicationId)).toMatchObject({
      status: "VERIFICATION_REVIEW",
      version: 1,
    });
  });

  it("supports information requests with immutable resubmission versions", async () => {
    const fixture = await seedSubmittedApplication();
    const request = {
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      stage: "VERIFICATION" as const,
      actor: staffPrincipal(
        fixture.staff.VERIFICATION_OFFICER,
        "VERIFICATION_OFFICER",
      ),
      note: "Please provide a current statement.",
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const requested = await approvals.requestInformation(request);
    expect(requested.status).toBe("INFORMATION_REQUESTED");
    expect(await approvals.requestInformation(request)).toEqual(requested);
    const resubmitted = await approvals.resubmit({
      applicationId: fixture.applicationId,
      expectedVersion: requested.version,
      actor: customerPrincipal(fixture.applicantId),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(resubmitted).toMatchObject({
      status: "VERIFICATION_REVIEW",
      version: 3,
      applicationVersion: 2,
    });
    const versions = await queryTestSql<{ count: string }>(
      databaseUrl!,
      "select count(*)::text as count from application_version where application_id = $1",
      [fixture.applicationId],
    );
    expect(versions.count).toBe("2");
  });

  it("resubmits to the exact stage that requested information", async () => {
    const fixture = await seedSubmittedApplication();
    await executeTestSql(
      databaseUrl!,
      "update application set status = 'AGM_REVIEW' where id = $1",
      [fixture.applicationId],
    );
    const requested = await approvals.requestInformation({
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      stage: "AGM",
      actor: staffPrincipal(fixture.staff.AGM, "AGM"),
      note: "Please provide the signed statement.",
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    const resubmitted = await approvals.resubmit({
      applicationId: fixture.applicationId,
      expectedVersion: requested.version,
      actor: customerPrincipal(fixture.applicantId),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });

    expect(resubmitted).toMatchObject({
      status: "AGM_REVIEW",
      version: 3,
      applicationVersion: 2,
    });
    expect(
      await queryTestSql<{ status: string; version: number }>(
        databaseUrl!,
        "select status, version from application where id = $1",
        [fixture.applicationId],
      ),
    ).toMatchObject({ status: "AGM_REVIEW", version: 3 });
  });

  it("replays an approval idempotency key and rejects payload reuse", async () => {
    const fixture = await seedSubmittedApplication();
    const command = {
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      stage: "VERIFICATION" as const,
      actor: staffPrincipal(
        fixture.staff.VERIFICATION_OFFICER,
        "VERIFICATION_OFFICER",
      ),
      note: "Verified evidence.",
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const first = await approvals.approve(command);
    expect(await approvals.approve(command)).toEqual(first);
    await expect(
      approvals.approve({ ...command, note: "Changed evidence." }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE" });
  });

  it("replays a customer resubmission and rejects key reuse by another actor", async () => {
    const fixture = await seedSubmittedApplication();
    const requested = await approvals.requestInformation({
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      stage: "VERIFICATION",
      actor: staffPrincipal(
        fixture.staff.VERIFICATION_OFFICER,
        "VERIFICATION_OFFICER",
      ),
      note: "Please provide one more statement.",
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    const command = {
      applicationId: fixture.applicationId,
      expectedVersion: requested.version,
      actor: customerPrincipal(fixture.applicantId),
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const first = await approvals.resubmit(command);
    expect(await approvals.resubmit(command)).toEqual(first);
    await expect(
      approvals.resubmit({
        ...command,
        actor: customerPrincipal(randomUUID()),
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE" });
  });

  it("makes rejection terminal and rejects stale or duplicate decisions", async () => {
    const fixture = await seedSubmittedApplication();
    const result = await approvals.reject({
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      stage: "VERIFICATION",
      actor: staffPrincipal(
        fixture.staff.VERIFICATION_OFFICER,
        "VERIFICATION_OFFICER",
      ),
      note: "Evidence could not be verified.",
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(result.status).toBe("REJECTED");
    await expect(
      approvals.approve({
        applicationId: fixture.applicationId,
        expectedVersion: result.version,
        stage: "VERIFICATION",
        actor: staffPrincipal(
          fixture.staff.VERIFICATION_OFFICER,
          "VERIFICATION_OFFICER",
        ),
        note: "late approval",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_TERMINAL" });
  });

  it("records actor, role, identity, audit, and outbox atomically", async () => {
    const fixture = await seedSubmittedApplication();
    const requestId = randomUUID();
    const idempotencyKey = randomUUID();
    await approvals.approve({
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      stage: "VERIFICATION",
      actor: staffPrincipal(
        fixture.staff.VERIFICATION_OFFICER,
        "VERIFICATION_OFFICER",
      ),
      note: "Verified evidence.",
      requestId,
      idempotencyKey,
    });
    const events = await readAuditEventsForAggregate(
      databaseUrl!,
      "application",
      fixture.applicationId,
    );
    expect(events).toContainEqual({
      action: "APPLICATION_APPROVAL_DECIDED",
      data: expect.objectContaining({
        actorStaffUserId: fixture.staff.VERIFICATION_OFFICER,
        actorRole: "VERIFICATION_OFFICER",
        stage: "VERIFICATION",
        note: "Verified evidence.",
        requestId,
        idempotencyKey,
        outcome: "APPROVE",
      }),
    });
    expect(
      await queryTestSql<{ count: string }>(
        databaseUrl!,
        "select count(*)::text as count from outbox_message where aggregate_id = $1 and topic = 'applications.approval_decided'",
        [fixture.applicationId],
      ),
    ).toMatchObject({ count: "1" });
  });

  it("records manual credit-bureau evidence without approving or rejecting", async () => {
    const fixture = await seedSubmittedApplication();
    const evidenceDocumentId = await seedBureauEvidence(fixture.applicantId);
    const checked = await underwriting.recordManualCreditBureauCheck({
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      actor: staffPrincipal(
        fixture.staff.VERIFICATION_OFFICER,
        "VERIFICATION_OFFICER",
      ),
      result: "CLEAN",
      checkedAt: "2026-08-20T10:00:00.000Z",
      bureauReference: "bureau-ref-001",
      evidenceDocumentId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(checked).toMatchObject({ result: "CLEAN", evidenceDocumentId });
    expect(await readApplication(fixture.applicationId)).toMatchObject({
      status: "VERIFICATION_REVIEW",
      version: 1,
    });
  });

  it("replays manual bureau evidence with its real version and rejects key reuse", async () => {
    const fixture = await seedSubmittedApplication();
    const evidenceDocumentId = await seedBureauEvidence(fixture.applicantId);
    const command = {
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      actor: staffPrincipal(
        fixture.staff.VERIFICATION_OFFICER,
        "VERIFICATION_OFFICER",
      ),
      result: "CLEAN" as const,
      checkedAt: "2026-08-20T10:00:00.000Z",
      bureauReference: "bureau-ref-replay",
      evidenceDocumentId,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    };
    const version = await queryTestSql<{ id: string }>(
      databaseUrl!,
      "select id from application_version where application_id = $1 and version_number = 1",
      [fixture.applicationId],
    );
    const first = await underwriting.recordManualCreditBureauCheck(command);
    expect(first.applicationVersionId).toBe(version.id);
    expect(await underwriting.recordManualCreditBureauCheck(command)).toEqual(
      first,
    );
    await expect(
      underwriting.recordManualCreditBureauCheck({
        ...command,
        bureauReference: "bureau-ref-different",
      }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSE" });
  });

  it("fails closed for an unsupported manual bureau result", async () => {
    const fixture = await seedSubmittedApplication();
    const evidenceDocumentId = await seedBureauEvidence(fixture.applicantId);
    await expect(
      underwriting.recordManualCreditBureauCheck({
        applicationId: fixture.applicationId,
        expectedVersion: 1,
        actor: staffPrincipal(
          fixture.staff.VERIFICATION_OFFICER,
          "VERIFICATION_OFFICER",
        ),
        result: "NO_MATCH" as never,
        checkedAt: "2026-08-20T10:00:00.000Z",
        bureauReference: "bureau-ref-invalid",
        evidenceDocumentId,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "BUREAU_RESULT_INVALID" });
  });
});

describe("approval separation of duties", () => {
  it("denies technical administrators and self-requested exceptions", () => {
    const admin = staffPrincipal(randomUUID(), "SYSTEM_ADMIN");
    expect(() => assertDecisionAllowed(admin, "MD")).toThrow("FORBIDDEN");
    const md = staffPrincipal(randomUUID(), "MD");
    expect(() =>
      assertDecisionAllowed(md, "MD", { exceptionRequestedBy: md.staffUserId }),
    ).toThrow("EXCEPTION_REQUESTER_CANNOT_APPROVE");
  });

  it("expires a temporary delegation at its effective end", () => {
    const delegated = staffPrincipal(randomUUID(), "CUSTOMER_SUPPORT");
    expect(() =>
      assertDecisionAllowed(delegated, "BSM_INITIAL", {
        delegation: {
          delegateId: delegated.staffUserId,
          role: "BSM",
          scope: ["BSM_INITIAL"],
          approvedBy: randomUUID(),
          effectiveFrom: "2026-08-20T09:00:00.000Z",
          effectiveUntil: "2026-08-20T10:00:00.000Z",
        },
        now: "2026-08-20T10:00:00.001Z",
      }),
    ).toThrow("DELEGATION_EXPIRED");
  });

  it("resolves only an approved persisted delegation and audits actor role separately", async () => {
    const fixture = await seedSubmittedApplication();
    const delegatedUser = await seedStaff(
      "delegated-support",
      "CUSTOMER_SUPPORT",
    );
    const approver = await seedStaff("delegation-approver", "MD");
    await seedDelegation({
      delegatedUser,
      approvedBy: approver,
      role: "VERIFICATION_OFFICER",
      scope: ["VERIFICATION"],
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveUntil: "2099-01-01T00:00:00.000Z",
      status: "APPROVED",
    });
    const result = await approvals.approve({
      applicationId: fixture.applicationId,
      expectedVersion: 1,
      stage: "VERIFICATION",
      actor: staffPrincipal(delegatedUser, "CUSTOMER_SUPPORT"),
      note: "Delegated verification.",
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(result.status).toBe("BSM_INITIAL_REVIEW");
    expect(
      await readAuditEventsForAggregate(
        databaseUrl!,
        "application",
        fixture.applicationId,
      ),
    ).toContainEqual(
      expect.objectContaining({
        action: "APPLICATION_APPROVAL_DECIDED",
        data: expect.objectContaining({
          actorRole: "CUSTOMER_SUPPORT",
          stage: "VERIFICATION",
          delegationId: expect.any(String),
          delegationEffectiveUntil: "2099-01-01T00:00:00.000Z",
        }),
      }),
    );
  });

  it("does not accept fabricated or expired delegation input", async () => {
    const fixture = await seedSubmittedApplication();
    const delegatedUser = await seedStaff(
      "fabricated-support",
      "CUSTOMER_SUPPORT",
    );
    const fakeDelegation = {
      delegateId: delegatedUser,
      role: "VERIFICATION_OFFICER" as const,
      scope: ["VERIFICATION" as const],
      approvedBy: randomUUID(),
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveUntil: "2099-01-01T00:00:00.000Z",
    };
    await expect(
      approvals.approve({
        applicationId: fixture.applicationId,
        expectedVersion: 1,
        stage: "VERIFICATION",
        actor: staffPrincipal(delegatedUser, "CUSTOMER_SUPPORT"),
        note: "Fabricated delegation.",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
        delegation: fakeDelegation,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const expiredFixture = await seedSubmittedApplication();
    const expiredUser = await seedStaff("expired-support", "CUSTOMER_SUPPORT");
    const expiredApprover = await seedStaff("expired-approver", "MD");
    await seedDelegation({
      delegatedUser: expiredUser,
      approvedBy: expiredApprover,
      role: "VERIFICATION_OFFICER",
      scope: ["VERIFICATION"],
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveUntil: "2021-01-01T00:00:00.000Z",
      status: "APPROVED",
    });
    await expect(
      approvals.approve({
        applicationId: expiredFixture.applicationId,
        expectedVersion: 1,
        stage: "VERIFICATION",
        actor: staffPrincipal(expiredUser, "CUSTOMER_SUPPORT"),
        note: "Expired delegation.",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const scopedFixture = await seedSubmittedApplication();
    const scopedUser = await seedStaff(
      "wrong-scope-support",
      "CUSTOMER_SUPPORT",
    );
    const scopedApprover = await seedStaff("wrong-scope-approver", "MD");
    await seedDelegation({
      delegatedUser: scopedUser,
      approvedBy: scopedApprover,
      role: "VERIFICATION_OFFICER",
      scope: ["AGM"],
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveUntil: "2099-01-01T00:00:00.000Z",
      status: "APPROVED",
    });
    await expect(
      approvals.approve({
        applicationId: scopedFixture.applicationId,
        expectedVersion: 1,
        stage: "VERIFICATION",
        actor: staffPrincipal(scopedUser, "CUSTOMER_SUPPORT"),
        note: "Wrong scope.",
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("approval detail access", () => {
  it("does not expose an actionable application to an unrelated staff role", async () => {
    const fixture = await seedSubmittedApplication();
    const support = await seedStaff("detail-support", "CUSTOMER_SUPPORT");
    await expect(
      approvals.getApplication({
        applicationId: fixture.applicationId,
        actor: staffPrincipal(support, "CUSTOMER_SUPPORT"),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("approval HTTP routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      config: httpTestConfig,
      database,
      logger: false,
      mfaVerifier: {
        kind: "test",
        async verify({ assertion }) {
          return assertion === "valid-test-assertion";
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("requires staff authentication and validates approval command schemas", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v1/staff/applications/queue",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "POST",
      url: `/v1/staff/applications/${randomUUID()}/approve`,
      payload: {
        expectedVersion: 1,
        stage: "NOT_A_STAGE",
        note: "invalid",
        idempotencyKey: randomUUID(),
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("denies unrelated roles from reading application details over HTTP", async () => {
    const fixture = await seedSubmittedApplication();
    const support = await seedHttpStaff("http-support", "CUSTOMER_SUPPORT");
    const login = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      payload: {
        email: support.email,
        password: "correct horse battery staple",
        mfaAssertion: "valid-test-assertion",
      },
    });
    expect(login.statusCode).toBe(201);
    const cookie = (
      Array.isArray(login.headers["set-cookie"])
        ? login.headers["set-cookie"]
        : [login.headers["set-cookie"]]
    ).find(
      (value) =>
        typeof value === "string" &&
        value.startsWith(`${httpTestConfig.cookieName}=`),
    );
    expect(cookie).toEqual(expect.any(String));
    const cookieValue = typeof cookie === "string" ? cookie : "";

    const response = await app.inject({
      method: "GET",
      url: `/v1/staff/applications/${fixture.applicationId}`,
      headers: { cookie: cookieValue.split(";", 1)[0] },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "FORBIDDEN" });
  });
});

function staffPrincipal(staffUserId: string, role: string): StaffPrincipal {
  return {
    kind: "staff",
    staffUserId,
    roles: [role as StaffRole],
    sessionId: randomUUID(),
  };
}

function customerPrincipal(personId: string): CustomerPrincipal {
  return {
    kind: "customer",
    customerAccountId: randomUUID(),
    personId,
    sessionId: randomUUID(),
  };
}

async function seedSubmittedApplication() {
  const applicantId = randomUUID();
  await executeTestSql(
    databaseUrl!,
    "insert into privacy.person (id, phone_e164) values ($1, $2)",
    [
      applicantId,
      `+2332${Math.floor(Math.random() * 100000000)
        .toString()
        .padStart(8, "0")}`,
    ],
  );
  const applicationId = randomUUID();
  await executeTestSql(
    databaseUrl!,
    `insert into application (id, applicant_person_id, status, version, submitted_at)
     values ($1, $2, 'VERIFICATION_REVIEW', 1, now())`,
    [applicationId, applicantId],
  );
  await executeTestSql(
    databaseUrl!,
    `insert into application_version (id, application_id, version_number, snapshot, submitted_at)
     values ($1, $2, 1, $3::jsonb, now())`,
    [
      randomUUID(),
      applicationId,
      JSON.stringify({ applicationId, applicantPersonId: applicantId }),
    ],
  );
  const staff = {
    VERIFICATION_OFFICER: await seedStaff(
      "verification",
      "VERIFICATION_OFFICER",
    ),
    BSM: await seedStaff("bsm", "BSM"),
    AGM: await seedStaff("agm", "AGM"),
    CFO: await seedStaff("cfo", "CFO"),
    MD: await seedStaff("md", "MD"),
  };
  return { applicationId, applicantId, staff };
}

async function seedStaff(label: string, role: string): Promise<string> {
  const user = await createStaffUser(database, {
    email: `${label}-${randomUUID()}@example.test`,
    passwordHash: "test-password-hash",
    roles: [role as DatabaseStaffRole],
  });
  return user.id;
}

async function seedHttpStaff(label: string, role: string) {
  return createStaffUser(database, {
    email: `${label}-${randomUUID()}@example.test`,
    passwordHash: await argon2.hash("correct horse battery staple", {
      type: argon2.argon2id,
      memoryCost: httpTestConfig.argon2MemoryCostKiB,
      timeCost: httpTestConfig.argon2TimeCost,
      parallelism: httpTestConfig.argon2Parallelism,
    }),
    roles: [role as DatabaseStaffRole],
  });
}

async function seedBureauEvidence(personId: string): Promise<string> {
  const id = randomUUID();
  await executeTestSql(
    databaseUrl!,
    `insert into privacy.document
      (id, person_id, document_type, object_key, declared_mime_type, declared_size_bytes,
       upload_ticket_hash, upload_expires_at, accepted_object_key, accepted_object_version_id,
       accepted_object_etag, sha256, status, malware_scanned)
     values ($1, $2, 'CREDIT_BUREAU_REPORT', $3, 'application/pdf', 128, repeat('a', 64),
       now() + interval '5 minutes', $4, 'v1', 'etag', repeat('b', 64), 'ACCEPTED', true)`,
    [id, personId, `pending/${id}`, `accepted/${id}`],
  );
  return id;
}

async function seedDelegation(input: {
  delegatedUser: string;
  approvedBy: string;
  role: string;
  scope: string[];
  effectiveFrom: string;
  effectiveUntil: string;
  status: "APPROVED" | "PENDING";
}): Promise<string> {
  const id = randomUUID();
  await executeTestSql(
    databaseUrl!,
    `insert into staff_delegation
      (id, delegated_staff_user_id, delegated_role, scope, approved_by,
       approved_at, effective_from, effective_until, status)
     values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
    [
      id,
      input.delegatedUser,
      input.role,
      JSON.stringify(input.scope),
      input.approvedBy,
      input.status === "APPROVED" ? input.effectiveFrom : null,
      input.effectiveFrom,
      input.effectiveUntil,
      input.status,
    ],
  );
  return id;
}

async function readApplication(applicationId: string) {
  return queryTestSql<{ status: string; version: number }>(
    databaseUrl!,
    "select status, version from application where id = $1",
    [applicationId],
  );
}

const httpTestConfig: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: databaseUrl!,
  allowedOrigins: ["https://staff.test.somo.example"],
  cookieName: "somo_staff_session",
  cookieSecret: "test-cookie-secret-with-at-least-32-characters",
  auditTargetHmacSecret: "test-audit-target-secret-with-at-least-32-characters",
  cookieSecure: false,
  bodyLimitBytes: 1_024,
  rateLimitMax: 10,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};
