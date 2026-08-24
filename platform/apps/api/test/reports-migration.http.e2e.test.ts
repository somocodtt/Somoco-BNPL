import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type Database,
} from "@somo/db";
import { resetTestDatabase } from "../../../packages/testkit/src/database.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
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
  cookieSecure: true,
  bodyLimitBytes: 1_048_576,
  rateLimitMax: 20,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};

const mfaVerifier = {
  kind: "test" as const,
  async verify(input: { assertion: string }) {
    return input.assertion === "valid-test-assertion";
  },
};

describe("reporting and migration HTTP boundaries", () => {
  let database: Database;
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeAll(async () => {
    await resetTestDatabase(databaseUrl);
    const connection = createDatabase(databaseUrl);
    database = connection.db;
    close = connection.close;
    await migrateDatabase(database);
    app = await buildApp({ config, database, logger: false, mfaVerifier });
  });

  afterAll(async () => {
    await app.close();
    await close();
  });

  it("requires staff authentication and CSRF, while enforcing migration roles", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v1/staff/reports/operations",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const email = "report-support@example.test";
    await createStaffUser(database, {
      email,
      passwordHash: await argon2.hash("correct horse battery staple", {
        type: argon2.argon2id,
        memoryCost: config.argon2MemoryCostKiB,
        timeCost: config.argon2TimeCost,
        parallelism: config.argon2Parallelism,
      }),
      roles: ["CUSTOMER_SUPPORT"],
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      remoteAddress: "203.0.113.61",
      payload: {
        email,
        password: "correct horse battery staple",
        mfaAssertion: "valid-test-assertion",
      },
    });
    expect(login.statusCode).toBe(201);
    const cookie = (
      Array.isArray(login.headers["set-cookie"])
        ? login.headers["set-cookie"]
        : [login.headers["set-cookie"]]
    )
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const csrfToken = login.json<{ csrfToken: string }>().csrfToken;

    const report = await app.inject({
      method: "GET",
      url: "/v1/staff/reports/operations",
      headers: { cookie },
    });
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ dataClassification: "REDACTED" });

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/v1/staff/reports/exports",
      headers: { cookie },
      payload: { report: "operations", format: "CSV" },
    });
    expect(missingCsrf.statusCode).toBe(403);

    const exportResponse = await app.inject({
      method: "POST",
      url: "/v1/staff/reports/exports",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: { report: "operations", format: "CSV" },
    });
    expect(exportResponse.statusCode).toBe(201);

    const migrationDenied = await app.inject({
      method: "POST",
      url: "/v1/staff/migrations/import",
      headers: { cookie, "x-csrf-token": csrfToken },
      payload: {
        source: "LEGACY_CSV",
        sourceBatchId: "http-denied",
        sourceFileHash: "a".repeat(64),
        templateVersion: "legacy-v1",
        expectedRecords: 0,
        rows: [],
      },
    });
    expect(migrationDenied.statusCode).toBe(403);

    const auditorEmail = "report-auditor@example.test";
    await createStaffUser(database, {
      email: auditorEmail,
      passwordHash: await argon2.hash("correct horse battery staple", {
        type: argon2.argon2id,
        memoryCost: config.argon2MemoryCostKiB,
        timeCost: config.argon2TimeCost,
        parallelism: config.argon2Parallelism,
      }),
      roles: ["COMPLIANCE_AUDITOR"],
    });
    const auditorLogin = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      remoteAddress: "203.0.113.62",
      payload: {
        email: auditorEmail,
        password: "correct horse battery staple",
        mfaAssertion: "valid-test-assertion",
      },
    });
    const auditorCookie = (
      Array.isArray(auditorLogin.headers["set-cookie"])
        ? auditorLogin.headers["set-cookie"]
        : [auditorLogin.headers["set-cookie"]]
    )
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.split(";", 1)[0])
      .join("; ");
    const auditorCsrf = auditorLogin.json<{ csrfToken: string }>().csrfToken;
    const auditorMutation = await app.inject({
      method: "POST",
      url: `/v1/staff/migrations/${randomUUID()}/verify`,
      headers: { cookie: auditorCookie, "x-csrf-token": auditorCsrf },
      payload: {},
    });
    expect(auditorMutation.statusCode).toBe(403);
    const auditorImport = await app.inject({
      method: "POST",
      url: "/v1/staff/migrations/import",
      headers: { cookie: auditorCookie, "x-csrf-token": auditorCsrf },
      payload: {
        source: "LEGACY_CSV",
        sourceBatchId: "auditor-import",
        sourceFileHash: "b".repeat(64),
        templateVersion: "legacy-v1",
        expectedRecords: 0,
        rows: [],
      },
    });
    expect(auditorImport.statusCode).toBe(403);
  });
});
