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
import { resetTestDatabase } from "../../../packages/testkit/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined)
  throw new Error(
    "TEST_DATABASE_URL is required for asset HTTP integration tests",
  );

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
  bodyLimitBytes: 10_000,
  rateLimitMax: 20,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};

let database: Database;
let closeDatabase: () => Promise<void>;
let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  const connection = createDatabase(databaseUrl);
  database = connection.db;
  closeDatabase = connection.close;
  app = await buildApp({
    config,
    database,
    logger: false,
    mfaVerifier: {
      kind: "test",
      async verify({ assertion }) {
        return assertion === "valid";
      },
    },
  });
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl);
  await migrateDatabase(database);
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe("asset and contract HTTP boundary", () => {
  it("requires staff authentication and rejects malformed asset commands", async () => {
    const unauthenticated = await app.inject({
      method: "GET",
      url: "/v1/staff/assets",
    });
    expect(unauthenticated.statusCode).toBe(401);

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/staff/assets",
      payload: { vin: "VIN-1", idempotencyKey: "short" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("returns an empty JSON-safe inventory only to an authorized inventory role", async () => {
    const passwordHash = await argon2.hash("correct horse battery staple", {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const inventory = await createStaffUser(database, {
      email: `inventory-${randomUUID()}@example.test`,
      passwordHash,
      roles: ["INVENTORY_OFFICER"],
    });
    const login = await app.inject({
      method: "POST",
      url: "/v1/staff/sessions",
      payload: {
        email: inventory.email,
        password: "correct horse battery staple",
        mfaAssertion: "valid",
      },
    });
    expect(login.statusCode).toBe(201);
    const cookie = (
      Array.isArray(login.headers["set-cookie"])
        ? login.headers["set-cookie"]
        : [login.headers["set-cookie"]]
    )[0];
    const listed = await app.inject({
      method: "GET",
      url: "/v1/staff/assets",
      headers: { cookie: String(cookie).split(";", 1)[0] },
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual([]);
    expect(() => JSON.stringify(listed.json())).not.toThrow();
  });

  it("requires optimistic version and durable idempotency fields on asset mutations", async () => {
    const vehicleUnitId = randomUUID();
    const registration = await app.inject({
      method: "POST",
      url: `/v1/staff/assets/${vehicleUnitId}/registration`,
      payload: {
        registrationNumber: "GT-1",
        validFrom: "2026-01-01",
        validTo: "2027-01-01",
      },
    });
    expect(registration.statusCode).toBe(400);
    const insurance = await app.inject({
      method: "POST",
      url: `/v1/staff/assets/${vehicleUnitId}/insurance`,
      payload: {
        policyNumber: "POLICY-1",
        provider: "Synthetic Insurer",
        validFrom: "2026-01-01",
        validTo: "2027-01-01",
      },
    });
    expect(insurance.statusCode).toBe(400);
    const tracker = await app.inject({
      method: "POST",
      url: `/v1/staff/assets/${vehicleUnitId}/tracker`,
      payload: {
        provider: "Synthetic Tracker",
        providerDeviceId: "device-1",
        deepLink: "https://tracker.example.test/device-1",
      },
    });
    expect(tracker.statusCode).toBe(400);
  });
});
