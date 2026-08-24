import { describe, expect, it } from "vitest";
import { loadConfig } from "../../apps/api/src/config.js";

const baseEnvironment: Record<string, string> = {
  NODE_ENV: "production",
  API_HOST: "127.0.0.1",
  API_PORT: "443",
  DATABASE_URL: "postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test",
  ALLOWED_ORIGINS: "https://customer.somo.example",
  STAFF_COOKIE_NAME: "somo_staff_session",
  COOKIE_SECRET: "production-cookie-secret-at-least-32-characters",
  AUDIT_TARGET_HMAC_SECRET: "production-audit-secret-at-least-32-characters",
  COOKIE_SECURE: "true",
  BODY_LIMIT_BYTES: "1048576",
  RATE_LIMIT_MAX: "100",
  RATE_LIMIT_WINDOW_MS: "60000",
  STAFF_SESSION_TTL_SECONDS: "3600",
  ARGON2_MEMORY_COST_KIB: "19456",
  ARGON2_TIME_COST: "2",
  ARGON2_PARALLELISM: "1",
  REQUIRE_VERIFIED_MFA: "true",
  NIA_ADAPTER: "approved-nia",
  SMS_ADAPTER: "approved-sms",
  PAYMENT_ADAPTER: "approved-payment",
  OBJECT_STORAGE_PUBLIC: "false",
  ENCRYPTION_KEY_REF: "secret/somo/prod/document-encryption",
  BACKUP_LAST_VERIFIED_AT: "2026-08-22T00:00:00.000Z",
};

describe("production security configuration", () => {
  it("rejects simulator and wrapped-simulator adapters", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, NIA_ADAPTER: "simulator" }),
    ).toThrow("PRODUCTION_SIMULATOR_ADAPTER_FORBIDDEN");
    expect(() =>
      loadConfig({ ...baseEnvironment, SMS_ADAPTER: "wrapped-simulator" }),
    ).toThrow("PRODUCTION_SIMULATOR_ADAPTER_FORBIDDEN");
  });

  it("fails closed for weak secrets, HTTP origins, MFA, storage, encryption, and backups", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, COOKIE_SECRET: "weak" }),
    ).toThrow("cookieSecret must be at least 32 characters");
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        ALLOWED_ORIGINS: "http://customer.somo.example",
      }),
    ).toThrow("production allowedOrigins must use HTTPS");
    expect(() =>
      loadConfig({ ...baseEnvironment, REQUIRE_VERIFIED_MFA: "false" }),
    ).toThrow("production staff sessions must require verified MFA");
    expect(() =>
      loadConfig({ ...baseEnvironment, OBJECT_STORAGE_PUBLIC: "true" }),
    ).toThrow("PRODUCTION_OBJECT_STORAGE_MUST_BE_PRIVATE");
    const withoutEncryption = { ...baseEnvironment };
    delete withoutEncryption.ENCRYPTION_KEY_REF;
    expect(() => loadConfig(withoutEncryption)).toThrow(
      "ENCRYPTION_KEY_REF is required",
    );
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        BACKUP_LAST_VERIFIED_AT: "2020-01-01T00:00:00.000Z",
      }),
    ).toThrow("PRODUCTION_BACKUP_VERIFICATION_STALE");
  });
});
