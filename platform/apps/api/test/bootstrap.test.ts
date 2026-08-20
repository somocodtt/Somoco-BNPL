import { describe, expect, it, vi } from "vitest";
import { createNiaSimulator } from "@somo/integrations/simulators";
import {
  createClamAvMalwareScanner,
  createProductionConnectorBoundary,
  createS3ObjectStorage,
  otpDerivationKeyId,
  type NiaPort,
} from "@somo/integrations";
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

  it("fails closed before build when application invitation policy is absent", async () => {
    const build = vi.fn();

    await expect(
      bootstrapApi({
        config,
        env: { NODE_ENV: "production" },
        build,
        loadComposition: async () => productionComposition(),
      }),
    ).rejects.toThrow("PRODUCTION_APPLICATION_POLICY_REQUIRED");
    expect(build).not.toHaveBeenCalled();
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
      env: {
        NODE_ENV: "production",
        APPLICATION_INVITATION_HASH_SECRET:
          "production-test-invitation-secret-at-least-32-chars",
        APPLICATION_INVITATION_TTL_MS: "1800000",
        APPLICATION_REQUIRED_DOCUMENT_TYPES: "GHANA_CARD_FRONT",
      },
      build,
      loadComposition,
    });

    expect(events).toEqual(["composition", "listen"]);
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(
      expect.objectContaining({
        applications: {
          invitationHashSecret:
            "production-test-invitation-secret-at-least-32-chars",
          invitationTtlMs: 1_800_000,
          requiredDocumentTypes: ["GHANA_CARD_FRONT"],
        },
      }),
    );
  });
});

function productionComposition() {
  const boundary = createProductionConnectorBoundary();
  const sms = boundary.register({
    kind: "SMS",
    provenance: {
      packageName: "@somo-external/synthetic-sms",
      packageVersion: "1.0.0",
      connectorId: "synthetic-sms",
    },
    adapter: {
      async send() {
        return {
          providerReference: "sms-production-test-1",
          acceptedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
  });
  const nia = boundary.register({
    kind: "NIA",
    provenance: {
      packageName: "@somo-external/synthetic-nia",
      packageVersion: "1.0.0",
      connectorId: "synthetic-nia",
    },
    adapter: {
      async verify() {
        return {
          providerReference: "nia-production-test-1",
          decision: "REVIEW" as const,
          checkedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
  });
  const storage = createS3ObjectStorage({
    endpoint: "https://storage.test.invalid",
    region: "test-1",
    bucket: "synthetic-production-test",
    accessKeyId: "synthetic-access-key",
    secretAccessKey: "synthetic-secret-key-at-least-32-characters",
  });
  const malwareScanner = createClamAvMalwareScanner({
    host: "127.0.0.1",
    port: 3310,
    timeoutMs: 1_000,
    maxBytes: 1_024,
    maxResponseBytes: 1_024,
  });
  const deliverySecret = "production-test-delivery-secret-with-32-characters";
  return {
    sms,
    nia,
    otpPolicy: {
      ttlMs: 120_000,
      attemptLimit: 3,
      resendCooldownMs: 30_000,
      codeLength: 6,
      hashSecret: "production-test-otp-secret-with-32-characters",
      deliveryDerivationSecret: deliverySecret,
      deliveryDerivationKeyId: otpDerivationKeyId(deliverySecret),
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
