import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
import { bootstrapApi } from "../src/bootstrap.js";
import type { AppConfig } from "../src/config.js";
import type { Database } from "@somo/db";

const testConfig: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl: "postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test",
  allowedOrigins: ["https://customer.test.somo.example"],
  cookieName: "somo_staff_session",
  cookieSecret: "test-cookie-secret-with-at-least-32-characters",
  auditTargetHmacSecret: "test-audit-target-secret-with-at-least-32-characters",
  cookieSecure: true,
  bodyLimitBytes: 1_024,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};

const productionConfig: AppConfig = {
  ...testConfig,
  environment: "production",
  port: 443,
  requireVerifiedMfa: true,
  niaAdapter: "approved-nia",
  smsAdapter: "approved-sms",
  paymentAdapter: "approved-payment",
  objectStoragePublic: false,
  encryptionKeyRef: "secret/somo/prod/document-encryption",
  backupLastVerifiedAt: "2026-08-23T00:00:00.000Z",
};

describe("Task 14 fix round 2", () => {
  it("rejects production NODE_ENV with an injected non-production config before composition or listen", async () => {
    const build = vi.fn();
    const loadComposition = vi.fn(async () => ({}));

    await expect(
      bootstrapApi({
        config: testConfig,
        env: { NODE_ENV: "production" },
        build,
        loadComposition,
      }),
    ).rejects.toThrow("BOOTSTRAP_ENVIRONMENT_MISMATCH");
    expect(loadComposition).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("does not downgrade an injected production config under a non-production NODE_ENV", async () => {
    const build = vi.fn();
    const loadComposition = vi.fn(async () => ({}));

    await expect(
      bootstrapApi({
        config: productionConfig,
        env: { NODE_ENV: "test" },
        build,
        loadComposition,
      }),
    ).rejects.toThrow("BOOTSTRAP_ENVIRONMENT_MISMATCH");
    expect(loadComposition).not.toHaveBeenCalled();
    expect(build).not.toHaveBeenCalled();
  });

  it("refreshes live readiness, protects postgres from spoofing, and recovers", async () => {
    let postgresState: "up" | "down" | "throw" = "up";
    let dependencyUp = true;
    let postgresSpoofCalls = 0;
    const app = await buildApp({
      config: testConfig,
      database: {} as Database,
      logger: false,
      databaseProbe: async () => {
        if (postgresState === "throw") throw new Error("database details");
        return postgresState === "up";
      },
      dependencyChecks: [
        {
          name: "queue",
          check: async () => dependencyUp,
        },
        {
          name: "postgres",
          check: async () => {
            postgresSpoofCalls += 1;
            return true;
          },
        },
      ],
    });

    const initial = await app.inject({ method: "GET", url: "/health/ready" });
    expect(initial.statusCode).toBe(200);
    expect(initial.json()).toEqual({ status: "ok" });

    postgresState = "down";
    const down = await app.inject({ method: "GET", url: "/health/ready" });
    expect(down.statusCode).toBe(503);
    expect(down.json()).toEqual({ status: "not_ready" });

    postgresState = "up";
    dependencyUp = false;
    const dependencyDown = await app.inject({
      method: "GET",
      url: "/health/ready",
    });
    expect(dependencyDown.statusCode).toBe(503);
    expect(dependencyDown.json()).toEqual({ status: "not_ready" });

    postgresState = "throw";
    dependencyUp = true;
    const failed = await app.inject({ method: "GET", url: "/health/ready" });
    expect(failed.statusCode).toBe(503);
    expect(failed.json()).toEqual({ status: "not_ready" });

    postgresState = "up";
    const recovered = await app.inject({
      method: "GET",
      url: "/health/ready",
    });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({ status: "ok" });
    expect(postgresSpoofCalls).toBe(0);
    await app.close();
  });
});
