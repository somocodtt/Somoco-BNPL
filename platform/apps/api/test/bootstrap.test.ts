import { describe, expect, it, vi } from "vitest";
import { createNiaSimulator } from "@somo/integrations/simulators";
import type { NiaPort } from "@somo/integrations";
import { markProductionAdapter } from "../../../packages/integrations/src/provenance.js";
import {
  bootstrapApi,
  validateProductionIdentityComposition,
} from "../src/bootstrap.js";
import type { AppConfig } from "../src/config.js";

const config: AppConfig = {
  environment: "production",
  host: "127.0.0.1",
  port: 443,
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
  requireVerifiedMfa: true,
};

describe("production API bootstrap", () => {
  it("fails before build/listen when the production composition module is absent", async () => {
    const build = vi.fn();

    await expect(
      bootstrapApi({ config, env: { NODE_ENV: "production" }, build }),
    ).rejects.toThrow("PRODUCTION_IDENTITY_COMPOSITION_MODULE_REQUIRED");
    expect(build).not.toHaveBeenCalled();
  });

  it("rejects partial and wrapped-simulator leaf composition", () => {
    const complete = productionComposition();
    expect(() =>
      validateProductionIdentityComposition({
        ...complete,
        nia: {},
      }),
    ).toThrow("PRODUCTION_IDENTITY_CAPABILITY_REQUIRED");
    const simulator = createNiaSimulator({ environment: "test", fixtures: [] });
    expect(() =>
      validateProductionIdentityComposition({
        ...complete,
        nia: {
          verify: (input: Parameters<NiaPort["verify"]>[0]) =>
            simulator.verify(input),
        },
      }),
    ).toThrow("PRODUCTION_IDENTITY_PROVENANCE_REQUIRED");
  });

  it("uses actual NODE_ENV, validates every leaf, and listens only afterward", async () => {
    const events: string[] = [];
    const build = vi.fn(async () => ({
      async listen() {
        events.push("listen");
      },
    }));
    const loadComposition = vi.fn(async () => {
      events.push("composition");
      return productionComposition();
    });

    await bootstrapApi({
      config: { ...config, environment: "test", port: 0 },
      env: { NODE_ENV: "production" },
      build,
      loadComposition,
    });

    expect(events).toEqual(["composition", "listen"]);
    expect(build).toHaveBeenCalledOnce();
  });
});

function productionComposition() {
  const sms = markProductionAdapter(
    {
      async send() {
        return {
          providerReference: "sms-production-test-1",
          acceptedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
    "SMS",
  );
  const nia = markProductionAdapter(
    {
      async verify() {
        return {
          providerReference: "nia-production-test-1",
          decision: "REVIEW" as const,
          checkedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
    "NIA",
  );
  const storage = markProductionAdapter(
    {
      async createUploadTicket(input: {
        requiredHeaders: Readonly<Record<string, string>>;
      }) {
        return {
          uploadUrl: "https://storage.test.invalid/upload",
          requiredHeaders: input.requiredHeaders,
        };
      },
      async readObject() {
        throw new Error("not used");
      },
      async promoteToImmutable() {
        throw new Error("not used");
      },
      async createDownloadTicket() {
        throw new Error("not used");
      },
    },
    "OBJECT_STORAGE",
  );
  const malwareScanner = markProductionAdapter(
    {
      async scan() {
        return { verdict: "ERROR" as const, scannerReference: "not-used" };
      },
    },
    "MALWARE_SCANNER",
  );
  return {
    sms,
    nia,
    otpPolicy: {
      ttlMs: 120_000,
      attemptLimit: 3,
      resendCooldownMs: 30_000,
      codeLength: 6,
      hashSecret: "production-test-otp-secret-with-32-characters",
      deliveryEncryptionSecret:
        "production-test-delivery-secret-with-32-characters",
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
    documents: {
      storage,
      malwareScanner,
      policy: {
        allowedMimeTypes: ["application/pdf"],
        maxBytes: 1_024,
        uploadTtlMs: 60_000,
        downloadTtlMs: 30_000,
      },
    },
  };
}
