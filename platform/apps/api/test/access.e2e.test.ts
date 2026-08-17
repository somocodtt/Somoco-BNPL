import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import {
  createDatabase,
  createStaffSessionForAccessVersion,
  createStaffUser,
  findActiveStaffSessionByTokenHash,
  findStaffUserByEmail,
  listAuditEventsByActor,
  listAuditEventsByRequestId,
  migrateDatabase,
  updateStaffUserAccess,
  withTransaction,
  type Database,
} from "@somo/db";
import argon2 from "argon2";
import {
  createClamAvMalwareScanner,
  createProductionConnectorBoundary,
  createS3ObjectStorage,
  otpDerivationKeyId,
} from "@somo/integrations";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { FastifyInstance } from "fastify";
import { loadConfig, validateConfig, type AppConfig } from "../src/config.js";
import {
  authorize,
  type StaffPrincipal,
} from "../src/modules/access/policy.js";
import type { StaffAction } from "../src/modules/access/actions.js";
import { createAccessService } from "../src/modules/access/service.js";
import { resetTestDatabase } from "../../../packages/testkit/src/database.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required for API integration tests");
}

const testConfig: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl,
  allowedOrigins: ["https://staff.test.somo.example"],
  cookieName: "somo_staff_session",
  cookieSecret: "test-cookie-secret-with-at-least-32-characters",
  auditTargetHmacSecret: "test-audit-target-secret-with-at-least-32-characters",
  cookieSecure: true,
  bodyLimitBytes: 1_024,
  rateLimitMax: 2,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};

const deterministicMfaVerifier = {
  kind: "test" as const,
  async verify(input: { assertion: string }) {
    return input.assertion === "valid-test-assertion";
  },
};

const productionConnectorBoundary = createProductionConnectorBoundary();
const productionDeliverySecret =
  "production-safe-test-delivery-secret-32-characters";
const productionIdentityTestDependencies = {
  sms: productionConnectorBoundary.register({
    kind: "SMS",
    provenance: {
      packageName: "@somo-external/synthetic-sms",
      packageVersion: "1.0.0",
      connectorId: "synthetic-sms",
    },
    adapter: {
      async send() {
        return {
          providerReference: "production-safe-sms-test-reference",
          acceptedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
  }),
  otpPolicy: {
    ttlMs: 120_000,
    attemptLimit: 3,
    resendCooldownMs: 30_000,
    codeLength: 6,
    hashSecret: "production-safe-test-otp-secret-32-characters",
    deliveryDerivationSecret: productionDeliverySecret,
    deliveryDerivationKeyId: otpDerivationKeyId(productionDeliverySecret),
    sessionTtlMs: 3_600_000,
  },
  consentCatalog: {
    documents: [
      {
        purpose: "NIA_IDENTITY_VERIFICATION",
        currentVersion: "nia-consent-v1",
      },
    ],
  },
  nia: productionConnectorBoundary.register({
    kind: "NIA",
    provenance: {
      packageName: "@somo-external/synthetic-nia",
      packageVersion: "1.0.0",
      connectorId: "synthetic-nia",
    },
    adapter: {
      async verify() {
        return {
          providerReference: "production-safe-nia-test-reference",
          decision: "REVIEW" as const,
          checkedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
  }),
  documents: {
    storage: createS3ObjectStorage({
      endpoint: "https://storage.test.invalid",
      region: "test-1",
      bucket: "synthetic-production-test",
      accessKeyId: "synthetic-access-key",
      secretAccessKey: "synthetic-secret-key-at-least-32-characters",
    }),
    malwareScanner: createClamAvMalwareScanner({
      host: "127.0.0.1",
      port: 3310,
      timeoutMs: 1_000,
      maxBytes: 1_024,
      maxResponseBytes: 1_024,
    }),
    policy: {
      allowedMimeTypes: ["application/pdf"],
      maxBytes: 1_024,
      uploadTtlMs: 60_000,
      downloadTtlMs: 30_000,
    },
  },
} satisfies NonNullable<BuildAppOptions["identity"]>;

let database: Database;
let closeDatabase: () => Promise<void>;

beforeAll(async () => {
  await resetTestDatabase(databaseUrl);
  const connection = createDatabase(databaseUrl);
  database = connection.db;
  closeDatabase = connection.close;
  await migrateDatabase(database);
});

afterAll(async () => {
  await closeDatabase();
});

describe("secured API shell", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      config: testConfig,
      database,
      logger: false,
      mfaVerifier: deterministicMfaVerifier,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("sets hardened response headers", async () => {
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["x-frame-options"]).toBe("SAMEORIGIN");
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
  });

  it("echoes a valid correlation ID and generates one when absent", async () => {
    const suppliedRequestId = randomUUID();
    const supplied = await app.inject({
      method: "GET",
      url: "/missing",
      headers: { "x-request-id": suppliedRequestId },
    });
    const generated = await app.inject({ method: "GET", url: "/missing" });

    expect(supplied.headers["x-request-id"]).toBe(suppliedRequestId);
    expect(generated.headers["x-request-id"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("returns stack-free JSON problem details", async () => {
    const response = await app.inject({ method: "GET", url: "/missing" });

    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain(
      "application/problem+json",
    );
    expect(response.json()).toMatchObject({
      type: "about:blank",
      title: "Not Found",
      status: 404,
      instance: "/missing",
      requestId: expect.any(String),
    });
    expect(response.body).not.toContain("stack");
    expect(response.body).not.toContain("at ");
  });

  it("rejects client-controlled MFA state as an unknown field", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      remoteAddress: "203.0.113.11",
      payload: {
        email: "admin@somo.example",
        password: "correct horse battery staple",
        mfaAssertion: "deterministic-test-assertion",
        mfaVerified: true,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      title: "Bad Request",
      status: 400,
      code: "VALIDATION_ERROR",
    });
  });

  it("limits oversized request bodies", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      remoteAddress: "203.0.113.12",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ value: "x".repeat(2_000) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ status: 413 });
  });

  it("allows only configured CORS origins", async () => {
    const allowed = await app.inject({
      method: "OPTIONS",
      url: "/v1/staff/sessions",
      headers: {
        origin: "https://staff.test.somo.example",
        "access-control-request-method": "POST",
      },
    });
    const denied = await app.inject({
      method: "OPTIONS",
      url: "/v1/staff/sessions",
      headers: {
        origin: "https://attacker.example",
        "access-control-request-method": "POST",
      },
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://staff.test.somo.example",
    );
    expect(denied.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits staff authentication attempts", async () => {
    const request = {
      method: "POST" as const,
      url: "/v1/staff/sessions",
      remoteAddress: "203.0.113.13",
      payload: {
        email: "admin@somo.example",
        password: "correct horse battery staple",
        mfaAssertion: "deterministic-test-assertion",
      },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);
    const limited = await app.inject(request);

    expect(first.statusCode).not.toBe(429);
    expect(second.statusCode).not.toBe(429);
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeDefined();
    expect(limited.json()).toMatchObject({
      title: "Too Many Requests",
      status: 429,
      code: "RATE_LIMITED",
    });
  });
});

describe("staff credentials and sessions", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      config: testConfig,
      database,
      logger: false,
      mfaVerifier: deterministicMfaVerifier,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("stores passwords as Argon2id hashes with the configured parameters", async () => {
    await seedStaff("hash-check@somo.example", ["SYSTEM_ADMIN"]);

    const stored = await findStaffUserByEmail(
      database,
      "hash-check@somo.example",
    );

    expect(stored?.passwordHash).toMatch(
      /^\$argon2id\$v=19\$m=19456,p=1,t=2\$/,
    );
    expect(stored?.passwordHash).not.toContain("correct horse battery staple");
  });

  it("requires the injected verifier to approve the opaque MFA assertion", async () => {
    await seedStaff("mfa-check@somo.example", ["SYSTEM_ADMIN"]);

    const response = await login(
      app,
      "mfa-check@somo.example",
      "invalid-test-assertion",
      "203.0.113.21",
    );

    expect(response.statusCode).toBe(401);
    expect(response.headers["set-cookie"]).toBeUndefined();
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("records uniform null-actor denial audits for known and unknown emails", async () => {
    await seedStaff("known-denial@somo.example", ["CUSTOMER_SUPPORT"]);
    const password = "definitely wrong password";
    const assertion = "denial-mfa-assertion";
    const known = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      remoteAddress: "203.0.113.25",
      payload: {
        email: "known-denial@somo.example",
        password,
        mfaAssertion: assertion,
      },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      remoteAddress: "203.0.113.26",
      payload: {
        email: "unknown-denial@somo.example",
        password,
        mfaAssertion: assertion,
      },
    });

    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    const knownAudits = await listAuditEventsByRequestId(
      database,
      known.json<{ requestId: string }>().requestId,
    );
    const unknownAudits = await listAuditEventsByRequestId(
      database,
      unknown.json<{ requestId: string }>().requestId,
    );
    expect(knownAudits).toHaveLength(1);
    expect(unknownAudits).toHaveLength(1);
    expect(auditDenialShape(knownAudits[0]!)).toEqual(
      auditDenialShape(unknownAudits[0]!),
    );
    expect(auditDenialShape(knownAudits[0]!)).toEqual({
      aggregateType: "staff_authentication_target",
      action: "STAFF_SESSION_DENIED",
      actorStaffUserId: null,
      data: { reason: "AUTHENTICATION_REJECTED" },
    });
    expect(knownAudits[0]!.aggregateId).not.toBe(unknownAudits[0]!.aggregateId);
    const persisted = JSON.stringify([...knownAudits, ...unknownAudits]);
    expect(persisted).not.toContain("known-denial@somo.example");
    expect(persisted).not.toContain("unknown-denial@somo.example");
    expect(persisted).not.toContain(password);
    expect(persisted).not.toContain(assertion);
  });

  it("stores only a hash of a verified session token and sets a hardened cookie", async () => {
    const user = await seedStaff("session-check@somo.example", [
      "SYSTEM_ADMIN",
    ]);

    const response = await login(
      app,
      "session-check@somo.example",
      "valid-test-assertion",
      "203.0.113.22",
    );

    expect(response.statusCode).toBe(201);
    const staffCookie = findCookie(response, testConfig.cookieName);
    expect(staffCookie.attributes).toContain("HttpOnly");
    expect(staffCookie.attributes).toContain("Secure");
    expect(staffCookie.attributes).toContain("SameSite=Strict");
    const unsigned = app.unsignCookie(decodeURIComponent(staffCookie.value));
    expect(unsigned.valid).toBe(true);
    const token = unsigned.value!;
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const stored = await findActiveStaffSessionByTokenHash(
      database,
      tokenHash,
      new Date(),
    );
    const rawLookup = await findActiveStaffSessionByTokenHash(
      database,
      token,
      new Date(),
    );
    expect(stored).toMatchObject({
      staffUserId: user.id,
      mfaVerified: true,
    });
    expect(rawLookup).toBeNull();
    expect(response.body).not.toContain(token);
  });

  it("requires CSRF for cookie-authenticated logout and revokes the session", async () => {
    await seedStaff("logout-check@somo.example", ["SYSTEM_ADMIN"]);
    const session = await login(
      app,
      "logout-check@somo.example",
      "valid-test-assertion",
      "203.0.113.23",
    );
    const cookie = cookieHeader(session);
    const csrfToken = session.json<{ csrfToken: string }>().csrfToken;

    const withoutCsrf = await app.inject({
      method: "DELETE",
      url: "/v1/staff/sessions/current",
      headers: { cookie },
    });
    const revoked = await app.inject({
      method: "DELETE",
      url: "/v1/staff/sessions/current",
      headers: { cookie, "x-csrf-token": csrfToken },
    });
    const repeated = await app.inject({
      method: "DELETE",
      url: "/v1/staff/sessions/current",
      headers: { cookie, "x-csrf-token": csrfToken },
    });

    expect(withoutCsrf.statusCode).toBe(403);
    expect(revoked.statusCode).toBe(204);
    expect(repeated.statusCode).toBe(401);
  });

  it("refuses production staff login without a production MFA verifier", async () => {
    await seedStaff("production-mfa@somo.example", ["SYSTEM_ADMIN"]);
    const productionApp = await buildApp({
      config: {
        ...testConfig,
        environment: "production",
        port: 3_000,
        requireVerifiedMfa: true,
      },
      database,
      logger: false,
      identity: productionIdentityTestDependencies,
    });
    try {
      const response = await login(
        productionApp,
        "production-mfa@somo.example",
        "opaque-production-assertion",
        "203.0.113.24",
      );
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        code: "MFA_VERIFIER_UNAVAILABLE",
      });
    } finally {
      await productionApp.close();
    }
  });
});

describe("staff account administration", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    app = await buildApp({
      config: testConfig,
      database,
      logger: false,
      mfaVerifier: deterministicMfaVerifier,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it("creates a normalized staff account without returning credentials", async () => {
    const admin = await seedStaff("creator@somo.example", ["SYSTEM_ADMIN"]);
    const session = await login(
      app,
      admin.email,
      "valid-test-assertion",
      "203.0.113.31",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/users",
      headers: authenticatedMutationHeaders(session),
      payload: {
        email: "  New.Officer@SOMO.EXAMPLE ",
        password: "another correct horse battery staple",
        roles: ["VERIFICATION_OFFICER"],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      email: "new.officer@somo.example",
      roles: ["VERIFICATION_OFFICER"],
      status: "ACTIVE",
      version: 1,
    });
    expect(response.body).not.toContain("password");
    expect(response.body).not.toContain("argon2");
    const stored = await findStaffUserByEmail(
      database,
      "new.officer@somo.example",
    );
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
    const audits = await listAuditEventsByActor(database, admin.id);
    expect(audits.some((event) => event.action === "ACCESS_ALLOWED")).toBe(
      true,
    );
    expect(audits.some((event) => event.action === "STAFF_USER_CREATED")).toBe(
      true,
    );
  });

  it("rejects duplicate staff roles", async () => {
    const admin = await seedStaff("strict-admin@somo.example", [
      "SYSTEM_ADMIN",
    ]);
    const session = await login(
      app,
      admin.email,
      "valid-test-assertion",
      "203.0.113.32",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/users",
      headers: authenticatedMutationHeaders(session),
      payload: {
        email: "duplicate-roles@somo.example",
        password: "another correct horse battery staple",
        roles: ["MD", "MD"],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("enforces normalized staff email uniqueness", async () => {
    const admin = await seedStaff("unique-admin@somo.example", [
      "SYSTEM_ADMIN",
    ]);
    await seedStaff("already.exists@somo.example", ["CUSTOMER_SUPPORT"]);
    const session = await login(
      app,
      admin.email,
      "valid-test-assertion",
      "203.0.113.36",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/users",
      headers: authenticatedMutationHeaders(session),
      payload: {
        email: " Already.Exists@SOMO.EXAMPLE ",
        password: "another correct horse battery staple",
        roles: ["CUSTOMER_SUPPORT"],
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "STAFF_USER_ALREADY_EXISTS",
    });
  });

  it("revokes a target user's active sessions when privileges change", async () => {
    const admin = await seedStaff("updater@somo.example", ["SYSTEM_ADMIN"]);
    const target = await seedStaff("target-md@somo.example", ["MD"]);
    const adminSession = await login(
      app,
      admin.email,
      "valid-test-assertion",
      "203.0.113.33",
    );
    const targetSession = await login(
      app,
      target.email,
      "valid-test-assertion",
      "203.0.113.34",
    );

    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/staff/users/${target.id}`,
      headers: authenticatedMutationHeaders(adminSession),
      payload: { expectedVersion: 1, roles: ["CFO"] },
    });
    const oldSession = await app.inject({
      method: "DELETE",
      url: "/v1/staff/sessions/current",
      headers: authenticatedMutationHeaders(targetSession),
    });

    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ roles: ["CFO"], version: 2 });
    expect(oldSession.statusCode).toBe(401);
  });

  it("audits a meaningful system-admin boundary denial without secrets", async () => {
    const md = await seedStaff("denied-md@somo.example", ["MD"]);
    const session = await login(
      app,
      md.email,
      "valid-test-assertion",
      "203.0.113.35",
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/staff/users",
      headers: authenticatedMutationHeaders(session),
      payload: {
        email: "must-not-create@somo.example",
        password: "secret password must never reach audit",
        roles: ["SYSTEM_ADMIN"],
      },
    });

    expect(response.statusCode).toBe(403);
    const audits = await listAuditEventsByActor(database, md.id);
    const denial = audits.find((event) => event.action === "ACCESS_DENIED");
    expect(denial?.data).toMatchObject({ action: "staff_user.create" });
    expect(JSON.stringify(denial)).not.toContain("secret password");
    expect(JSON.stringify(denial)).not.toContain("valid-test-assertion");
  });

  it("requires a status or roles change in an update", async () => {
    const admin = await seedStaff("empty-update-admin@somo.example", [
      "SYSTEM_ADMIN",
    ]);
    const target = await seedStaff("empty-update-target@somo.example", ["MD"]);
    const session = await login(
      app,
      admin.email,
      "valid-test-assertion",
      "203.0.113.37",
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/staff/users/${target.id}`,
      headers: authenticatedMutationHeaders(session),
      payload: { expectedVersion: 1 },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("rejects a stale staff-user update version", async () => {
    const admin = await seedStaff("stale-update-admin@somo.example", [
      "SYSTEM_ADMIN",
    ]);
    const target = await seedStaff("stale-update-target@somo.example", ["MD"]);
    const session = await login(
      app,
      admin.email,
      "valid-test-assertion",
      "203.0.113.38",
    );
    const response = await app.inject({
      method: "PATCH",
      url: `/v1/staff/users/${target.id}`,
      headers: authenticatedMutationHeaders(session),
      payload: { expectedVersion: 99, status: "LOCKED" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "STAFF_USER_VERSION_CONFLICT",
    });
  });
});

describe("staff access-version concurrency", () => {
  it("rejects a session insert when a privilege update commits first", async () => {
    const target = await seedStaff("update-first@somo.example", ["MD"]);
    const updateApplied = deferred<void>();
    const releaseUpdate = deferred<void>();
    const updated = withTransaction(database, async (tx) => {
      const result = await updateStaffUserAccess(tx, {
        staffUserId: target.id,
        expectedVersion: 1,
        roles: ["CFO"],
        changedAt: new Date(),
      });
      updateApplied.resolve();
      await releaseUpdate.promise;
      return result;
    });
    await updateApplied.promise;

    const loginStarted = deferred<void>();
    const tokenHash = createHash("sha256")
      .update("update-first-session-token")
      .digest("hex");
    const inserted = withTransaction(database, async (tx) => {
      loginStarted.resolve();
      return createStaffSessionForAccessVersion(tx, {
        staffUserId: target.id,
        expectedStaffUserVersion: 1,
        tokenHash,
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 60_000),
      });
    });
    const insertedOutcome = settle(inserted);
    await loginStarted.promise;
    releaseUpdate.resolve();

    await updated;
    const outcome = await insertedOutcome;
    if (outcome.status === "fulfilled") {
      throw new Error("Expected the stale session insert to be rejected");
    }
    expect(outcome.error).toMatchObject({
      message: "STAFF_USER_ACCESS_CHANGED",
    });
    expect(
      await findActiveStaffSessionByTokenHash(database, tokenHash, new Date()),
    ).toBeNull();
  });

  it("lets a later privilege update revoke a session inserted first", async () => {
    const target = await seedStaff("login-first@somo.example", ["MD"]);
    const sessionInserted = deferred<void>();
    const releaseLogin = deferred<void>();
    const tokenHash = createHash("sha256")
      .update("login-first-session-token")
      .digest("hex");
    const inserted = withTransaction(database, async (tx) => {
      const session = await createStaffSessionForAccessVersion(tx, {
        staffUserId: target.id,
        expectedStaffUserVersion: 1,
        tokenHash,
        mfaVerified: true,
        expiresAt: new Date(Date.now() + 60_000),
      });
      sessionInserted.resolve();
      await releaseLogin.promise;
      return session;
    });
    const insertedOutcome = settle(inserted);
    const insertionState = await Promise.race([
      sessionInserted.promise.then(() => "inserted" as const),
      insertedOutcome.then(() => "settled" as const),
    ]);
    expect(insertionState).toBe("inserted");

    const updateStarted = deferred<void>();
    const updated = withTransaction(database, async (tx) => {
      updateStarted.resolve();
      return updateStaffUserAccess(tx, {
        staffUserId: target.id,
        expectedVersion: 1,
        roles: ["CFO"],
        changedAt: new Date(),
      });
    });
    await updateStarted.promise;
    releaseLogin.resolve();

    await inserted;
    await updated;
    expect(
      await findActiveStaffSessionByTokenHash(database, tokenHash, new Date()),
    ).toBeNull();
  });

  it("rejects login when access changes during slow MFA", async () => {
    const target = await seedStaff("mfa-race@somo.example", ["MD"]);
    const mfaStarted = deferred<void>();
    const releaseMfa = deferred<void>();
    const service = await createAccessService({
      config: testConfig,
      database,
      mfaVerifier: {
        kind: "test",
        async verify() {
          mfaStarted.resolve();
          await releaseMfa.promise;
          return true;
        },
      },
    });
    const requestId = randomUUID();
    const loginAttempt = service.createSession({
      email: target.email,
      password: "correct horse battery staple",
      mfaAssertion: "slow-mfa-assertion",
      requestId,
    });
    await mfaStarted.promise;

    await withTransaction(database, (tx) =>
      updateStaffUserAccess(tx, {
        staffUserId: target.id,
        expectedVersion: 1,
        roles: ["CFO"],
        changedAt: new Date(),
      }),
    );
    releaseMfa.resolve();

    await expect(loginAttempt).rejects.toThrow("AUTHENTICATION_FAILED");
    const audits = await listAuditEventsByRequestId(database, requestId);
    expect(audits).toHaveLength(1);
    expect(auditDenialShape(audits[0]!)).toEqual({
      aggregateType: "staff_authentication_target",
      action: "STAFF_SESSION_DENIED",
      actorStaffUserId: null,
      data: { reason: "AUTHENTICATION_REJECTED" },
    });
  });
});

describe("fail-closed configuration and logging", () => {
  it("rejects missing production environment configuration", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(
      "API_HOST is required",
    );
  });

  it.each([
    ["database URL", { databaseUrl: "" }],
    ["allowed origins", { allowedOrigins: [] }],
    ["cookie secret", { cookieSecret: "too-short" }],
    ["audit target secret", { auditTargetHmacSecret: "too-short" }],
    ["secure cookie", { cookieSecure: false }],
    ["verified MFA", { requireVerifiedMfa: false }],
  ] as const)("rejects production without %s", (_label, override) => {
    expect(() =>
      validateConfig({
        ...testConfig,
        environment: "production",
        port: 3_000,
        requireVerifiedMfa: true,
        ...override,
      }),
    ).toThrow();
  });

  it("redacts passwords, MFA assertions, cookies, and authorization headers", async () => {
    let logs = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const loggingApp = await buildApp({
      config: testConfig,
      database,
      loggerStream: stream,
      mfaVerifier: deterministicMfaVerifier,
    });
    loggingApp.log.info(
      {
        body: {
          password: "log-password-secret",
          mfaAssertion: "log-mfa-secret",
        },
        req: {
          headers: {
            authorization: "Bearer log-authorization-secret",
            cookie: "log-cookie-secret",
          },
        },
        res: {
          headers: { "set-cookie": "log-set-cookie-secret" },
        },
      },
      "redaction probe",
    );
    await loggingApp.close();

    expect(logs).toContain("[REDACTED]");
    expect(logs).not.toContain("log-password-secret");
    expect(logs).not.toContain("log-mfa-secret");
    expect(logs).not.toContain("log-authorization-secret");
    expect(logs).not.toContain("log-cookie-secret");
    expect(logs).not.toContain("log-set-cookie-secret");
  });
});

describe("staff action policy", () => {
  it("distinguishes the BSM initial and final approval phases", () => {
    const principal: StaffPrincipal = {
      kind: "staff",
      staffUserId: randomUUID(),
      roles: ["BSM"],
      sessionId: randomUUID(),
    };

    expect(() =>
      authorize(principal, "application.approve.bsm.initial"),
    ).not.toThrow();
    expect(() =>
      authorize(principal, "application.approve.bsm.final"),
    ).not.toThrow();
  });

  it("preserves both BSM approval phases in authorization audits", async () => {
    const bsm = await seedStaff("bsm-audit@somo.example", ["BSM"]);
    const principal: StaffPrincipal = {
      kind: "staff",
      staffUserId: bsm.id,
      roles: ["BSM"],
      sessionId: randomUUID(),
    };
    const service = await createAccessService({
      config: testConfig,
      database,
      mfaVerifier: deterministicMfaVerifier,
    });

    await service.authorizePrivileged({
      principal,
      action: "application.approve.bsm.initial",
      requestId: randomUUID(),
    });
    await service.authorizePrivileged({
      principal,
      action: "application.approve.bsm.final",
      requestId: randomUUID(),
    });

    const actions = (await listAuditEventsByActor(database, bsm.id))
      .filter((event) => event.action === "ACCESS_ALLOWED")
      .map((event) => event.data.action);
    expect(actions).toEqual([
      "application.approve.bsm.initial",
      "application.approve.bsm.final",
    ]);
  });

  it("prevents a system administrator from approving a loan", () => {
    expect(() =>
      authorize(systemAdminPrincipal(), "application.approve.md"),
    ).toThrowError("FORBIDDEN");
  });

  it("allows the MD role to make the MD decision", () => {
    expect(() =>
      authorize(mdPrincipal(), "application.approve.md"),
    ).not.toThrow();
  });

  it.each([
    "payment.post",
    "recovery.authorize",
    "ownership.transfer",
  ] as const)(
    "prevents a system administrator from performing %s",
    (action) => {
      expect(() => authorize(systemAdminPrincipal(), action)).toThrowError(
        "FORBIDDEN",
      );
    },
  );

  it("allows a system administrator to administer staff accounts", () => {
    expect(() =>
      authorize(systemAdminPrincipal(), "staff_user.update"),
    ).not.toThrow();
  });

  it("keeps system administration separated even when another role is assigned", () => {
    expect(() =>
      authorize(
        { ...systemAdminPrincipal(), roles: ["SYSTEM_ADMIN", "MD"] },
        "application.approve.md",
      ),
    ).toThrowError("FORBIDDEN");
  });

  it("fails closed for an unrecognized runtime action", () => {
    expect(() =>
      authorize(systemAdminPrincipal(), "unknown.action" as StaffAction),
    ).toThrowError("FORBIDDEN");
  });
});

function systemAdminPrincipal(): StaffPrincipal {
  return {
    kind: "staff",
    staffUserId: randomUUID(),
    roles: ["SYSTEM_ADMIN"],
    sessionId: randomUUID(),
  };
}

function mdPrincipal(): StaffPrincipal {
  return {
    kind: "staff",
    staffUserId: randomUUID(),
    roles: ["MD"],
    sessionId: randomUUID(),
  };
}

type InjectionResponse = Awaited<ReturnType<FastifyInstance["inject"]>>;

async function seedStaff(email: string, roles: StaffPrincipal["roles"]) {
  const passwordHash = await argon2.hash("correct horse battery staple", {
    type: argon2.argon2id,
    memoryCost: testConfig.argon2MemoryCostKiB,
    timeCost: testConfig.argon2TimeCost,
    parallelism: testConfig.argon2Parallelism,
  });
  return createStaffUser(database, {
    email,
    passwordHash,
    roles,
  });
}

async function login(
  app: FastifyInstance,
  email: string,
  assertion: string,
  remoteAddress: string,
): Promise<InjectionResponse> {
  return app.inject({
    method: "POST",
    url: "/v1/staff/sessions",
    remoteAddress,
    payload: {
      email,
      password: "correct horse battery staple",
      mfaAssertion: assertion,
    },
  });
}

function cookieHeader(response: InjectionResponse): string {
  const values = response.headers["set-cookie"];
  return (Array.isArray(values) ? values : [values])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

function findCookie(
  response: InjectionResponse,
  name: string,
): { value: string; attributes: string } {
  const values = response.headers["set-cookie"];
  const cookie = (Array.isArray(values) ? values : [values])
    .filter((value): value is string => typeof value === "string")
    .find((value) => value.startsWith(`${name}=`));
  if (cookie === undefined) {
    throw new Error(`Cookie ${name} was not set`);
  }
  const [pair, ...attributes] = cookie.split(";").map((part) => part.trim());
  const value = pair!.slice(name.length + 1);
  return { value, attributes: attributes.join(";") };
}

function authenticatedMutationHeaders(response: InjectionResponse): {
  cookie: string;
  "x-csrf-token": string;
} {
  return {
    cookie: cookieHeader(response),
    "x-csrf-token": response.json<{ csrfToken: string }>().csrfToken,
  };
}

function auditDenialShape(event: {
  aggregateType: string;
  action: string;
  actorStaffUserId: string | null;
  data: Record<string, unknown>;
}) {
  return {
    aggregateType: event.aggregateType,
    action: event.action,
    actorStaffUserId: event.actorStaffUserId,
    data: event.data,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function settle<T>(promise: Promise<T>) {
  try {
    return { status: "fulfilled" as const, value: await promise };
  } catch (error) {
    return { status: "rejected" as const, error };
  }
}
