import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type Database,
  type DatabaseStaffRole,
} from "@somo/db";
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
    await expect(approvals.requestInformation(request)).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
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
        role: "VERIFICATION",
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

async function readApplication(applicationId: string) {
  return queryTestSql<{ status: string; version: number }>(
    databaseUrl!,
    "select status, version from application where id = $1",
    [applicationId],
  );
}
