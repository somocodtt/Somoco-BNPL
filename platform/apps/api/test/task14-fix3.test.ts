import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createClamAvMalwareScanner,
  createProductionConnectorBoundary,
  createS3ObjectStorage,
  otpDerivationKeyId,
  type Telemetry,
} from "@somo/integrations";
import type { Database } from "@somo/db";
import {
  ALLOCATION_POLICY_BEHAVIOR_DIGEST,
  ALLOCATION_POLICY_EXECUTION_KEY,
  ALLOCATION_POLICY_VERSION,
  hashAllocationEvidenceArtifact,
} from "../src/modules/payments/ledger-service.js";
import { buildApp, type BuildAppOptions } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { createPrivacyService } from "../src/modules/privacy/service.js";

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

describe("Task 14 fix round 3", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a production process with a direct test config before probe or telemetry", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const databaseProbe = vi.fn(async () => true);
    const dependencyCheck = vi.fn(async () => true);
    const telemetry = spyTelemetry();

    await expect(
      buildApp({
        ...validProductionOptions({
          databaseProbe,
          dependencyCheck,
          telemetry,
        }),
        config: testConfig,
      }),
    ).rejects.toThrow("BOOTSTRAP_ENVIRONMENT_MISMATCH");
    expect(databaseProbe).not.toHaveBeenCalled();
    expect(dependencyCheck).not.toHaveBeenCalled();
    expect(telemetry.setDependency).not.toHaveBeenCalled();
  });

  it("rejects a direct production config under a test process before probe or telemetry", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const databaseProbe = vi.fn(async () => true);
    const dependencyCheck = vi.fn(async () => true);
    const telemetry = spyTelemetry();

    await expect(
      buildApp({
        ...validProductionOptions({
          databaseProbe,
          dependencyCheck,
          telemetry,
        }),
        config: productionConfig,
      }),
    ).rejects.toThrow("BOOTSTRAP_ENVIRONMENT_MISMATCH");
    expect(databaseProbe).not.toHaveBeenCalled();
    expect(dependencyCheck).not.toHaveBeenCalled();
    expect(telemetry.setDependency).not.toHaveBeenCalled();
  });
});

function spyTelemetry(): Telemetry {
  return {
    correlationId: (candidate) =>
      candidate ?? "00000000-0000-4000-8000-000000000301",
    currentCorrelationId: () => undefined,
    enterCorrelationId: vi.fn(),
    withCorrelationId: async (_id, operation) => operation(),
    withJobCorrelation: (payload, correlationId) => ({
      ...payload,
      correlationId: correlationId ?? "00000000-0000-4000-8000-000000000301",
    }),
    correlationIdFromJob: () => undefined,
    redactLogRecord: (value) => value,
    setDependency: vi.fn(),
    recordQueueAge: vi.fn(),
    recordReconciliationVariance: vi.fn(),
    recordProviderFailure: vi.fn(),
    liveness: () => ({ status: "ok" }),
    readiness: () => ({ status: "ok" }),
    inspect: () => ({
      status: "ok",
      dependencies: {},
      queueAgeSeconds: null,
      reconciliationVarianceMinorUnits: null,
      providerFailures: {},
    }),
  };
}

function validProductionOptions(input: {
  databaseProbe: (database: Database) => Promise<boolean>;
  dependencyCheck: () => Promise<boolean>;
  telemetry: Telemetry;
}): BuildAppOptions {
  const boundary = createProductionConnectorBoundary();
  const sms = boundary.register({
    kind: "SMS",
    provenance: {
      packageName: "@somo-external/task14-fix3-sms",
      packageVersion: "1.0.0",
      connectorId: "task14-fix3-sms",
    },
    adapter: {
      async send() {
        return {
          providerReference: "not-called",
          acceptedAt: "2026-08-23T00:00:00.000Z",
        };
      },
    },
  });
  const nia = boundary.register({
    kind: "NIA",
    provenance: {
      packageName: "@somo-external/task14-fix3-nia",
      packageVersion: "1.0.0",
      connectorId: "task14-fix3-nia",
    },
    adapter: {
      async verify() {
        return {
          providerReference: "not-called",
          decision: "REVIEW" as const,
          checkedAt: "2026-08-23T00:00:00.000Z",
        };
      },
    },
  });
  const verifier = boundary.register({
    kind: "PAYMENTS",
    provenance: {
      packageName: "@somo-external/task14-fix3-payments",
      packageVersion: "1.0.0",
      connectorId: "task14-fix3-payments",
    },
    adapter: {
      async verify() {
        throw new Error("not-called");
      },
    },
  });
  const allocationPolicyEvidenceVerifier = boundary.register({
    kind: "ALLOCATION_POLICY_EVIDENCE",
    provenance: {
      packageName: "@somo-external/task14-fix3-policy",
      packageVersion: "1.0.0",
      connectorId: "task14-fix3-policy",
    },
    adapter: {
      async verify() {
        return { attestationReference: "not-called" };
      },
    },
  });
  const artifact = Object.freeze({
    externalArtifactId: "task14-fix3-policy-v1",
    artifactRevision: 1,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
  });

  return {
    database: {} as Database,
    databaseProbe: input.databaseProbe,
    telemetry: input.telemetry,
    dependencyChecks: [{ name: "queue", check: input.dependencyCheck }],
    logger: false,
    identity: {
      sms,
      nia,
      otpPolicy: {
        ttlMs: 120_000,
        attemptLimit: 3,
        resendCooldownMs: 30_000,
        codeLength: 6,
        hashSecret: "task14-fix3-otp-secret-at-least-32-characters",
        deliveryDerivationSecret:
          "task14-fix3-delivery-secret-at-least-32-characters",
        deliveryDerivationKeyId: otpDerivationKeyId(
          "task14-fix3-delivery-secret-at-least-32-characters",
        ),
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
        storage: createS3ObjectStorage({
          endpoint: "https://storage.task14-fix3.invalid",
          region: "task14-fix3",
          bucket: "task14-fix3",
          accessKeyId: "task14-fix3-access-key",
          secretAccessKey: "task14-fix3-secret-at-least-32-characters",
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
    },
    privacy: { service: createPrivacyService() },
    payments: {
      verifier,
      allocationPolicyEvidenceVerifier,
      allocationPolicy: {
        version: ALLOCATION_POLICY_VERSION,
        executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
        behaviorDigest: ALLOCATION_POLICY_BEHAVIOR_DIGEST,
        evidence: {
          artifact,
          evidenceHash: hashAllocationEvidenceArtifact(artifact),
          financeApprovedBy: "task14-fix3-finance",
          complianceApprovedBy: "task14-fix3-compliance",
          financeSignature: "task14-fix3-finance-signature",
          complianceSignature: "task14-fix3-compliance-signature",
          financeApprovedAt: "2026-08-01T00:00:00.000Z",
          complianceApprovedAt: "2026-08-01T01:00:00.000Z",
        },
      },
      sms,
      accountLinkBaseUrl: "https://accounts.task14-fix3.invalid",
      ussdInstructions: "Dial *000#",
    },
  };
}
