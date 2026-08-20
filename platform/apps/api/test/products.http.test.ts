import argon2 from "argon2";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type Database,
} from "@somo/db";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { executeTestSql, resetTestDatabase } from "../../../packages/testkit/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required for API integration tests");

let database: Database;
let closeDatabase: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const connection = createDatabase(databaseUrl!);
  database = connection.db;
  closeDatabase = connection.close;
  app = await buildApp({
    config,
    database,
    logger: false,
    mfaVerifier: { kind: "test", async verify({ assertion }) { return assertion === "valid"; } },
  });
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl!);
  await migrateDatabase(database);
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe("controlled financing HTTP boundary", () => {
  it("requires staff authentication and validates financing schemas", async () => {
    const unauthenticated = await app.inject({ method: "GET", url: "/v1/staff/products/rule-versions" });
    expect(unauthenticated.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "POST",
      url: `/v1/staff/products/rule-versions/${randomUUID()}/publish`,
      payload: { idempotencyKey: "short" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns a JSON-safe list DTO after staff authentication", async () => {
    const passwordHash = await argon2.hash("correct horse battery staple", { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
    const user = await createStaffUser(database, {
      email: `products-${randomUUID()}@example.test`,
      passwordHash,
      roles: ["PRODUCT_ADMIN"],
    });
    const vehicleModelId = randomUUID();
    const productId = randomUUID();
    const ruleId = randomUUID();
    await executeTestSql(databaseUrl!, "insert into vehicle_model (id, manufacturer, model_name, model_year, active) values ($1, 'HTTP Motors', 'DTO Pilot', 2026, true)", [vehicleModelId]);
    await executeTestSql(databaseUrl!, "insert into product (id, code, name, vehicle_model_id, status) values ($1, 'HTTP-DTO', 'HTTP DTO product', $2, 'ACTIVE')", [productId, vehicleModelId]);
    await executeTestSql(databaseUrl!, `insert into financing_rule_version
      (id, product_id, version_number, selling_price_minor_units, minimum_deposit_minor_units,
       annual_rate_bps, allowed_tenures_months, repayment_frequencies, calculation_method,
       permitted_fees, eligibility_policy, required_evidence, exception_policy,
       disclosure_version, fixture_hashes, licence_permitted, requested_by)
      values ($1, $2, 1, 100000, 30000, 0, '[6]'::jsonb, '["MONTHLY"]'::jsonb,
              'FLAT_MARKUP', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb,
              'http-disclosure-v1', '[]'::jsonb, false, $3)`, [ruleId, productId, user.id]);
    const login = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      payload: { email: user.email, password: "correct horse battery staple", mfaAssertion: "valid" },
    });
    expect(login.statusCode).toBe(201);
    const cookie = (Array.isArray(login.headers["set-cookie"]) ? login.headers["set-cookie"] : [login.headers["set-cookie"]])[0];
    const listed = await app.inject({ method: "GET", url: "/v1/staff/products/rule-versions", headers: { cookie: String(cookie).split(";", 1)[0] } });
    expect(listed.statusCode).toBe(200);
    expect(Array.isArray(listed.json())).toBe(true);
    expect(() => JSON.stringify(listed.json())).not.toThrow();
    expect(listed.json()[0]).toMatchObject({ id: ruleId, sellingPriceMinor: "100000", minimumDepositMinor: "30000" });
  });
});

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: databaseUrl!,
  allowedOrigins: ["https://staff.test.somo.example"],
  cookieName: "somo_staff_session",
  cookieSecret: "test-cookie-secret-with-at-least-32-characters",
  auditTargetHmacSecret: "test-audit-target-secret-with-at-least-32-characters",
  cookieSecure: false,
  bodyLimitBytes: 10_000,
  rateLimitMax: 20,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};
