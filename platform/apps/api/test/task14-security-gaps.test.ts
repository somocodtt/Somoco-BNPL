import { describe, expect, it, vi } from "vitest";
import fastify from "fastify";
import { currentOutboxCorrelationId } from "@somo/db";
import {
  createClamAvMalwareScanner,
  createProductionConnectorBoundary,
  createS3ObjectStorage,
  createTelemetry,
  otpDerivationKeyId,
} from "@somo/integrations";
import { bootstrapApi } from "../src/bootstrap.js";
import { validateConfig, type AppConfig } from "../src/config.js";
import { createPrivacyService } from "../src/modules/privacy/service.js";
import { registerRequestContext } from "../src/plugins/request-context.js";
import { verifyPilotGates } from "../src/pilot-gates.js";

const subjectId = "00000000-0000-4000-8000-000000000101";

const productionConfig: AppConfig = {
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
  niaAdapter: "approved-nia",
  smsAdapter: "approved-sms",
  paymentAdapter: "approved-payment",
  objectStoragePublic: false,
  encryptionKeyRef: "secret/somo/prod/document-encryption",
  backupLastVerifiedAt: new Date(Date.now() - 60_000).toISOString(),
};

describe("Task 14 adversarial security controls", () => {
  it("requires production controls for direct config construction", () => {
    const incomplete = { ...productionConfig };
    delete incomplete.niaAdapter;
    expect(() => validateConfig(incomplete)).toThrow(
      "PRODUCTION_NIA_ADAPTER_REQUIRED",
    );
  });

  it("requires signed, environment-bound pilot gates before production listen", async () => {
    const listen = vi.fn();
    await expect(
      bootstrapApi({
        config: productionConfig,
        env: {
          NODE_ENV: "production",
          APPLICATION_INVITATION_HASH_SECRET:
            "production-test-invitation-secret-at-least-32-chars",
          APPLICATION_INVITATION_TTL_MS: "1800000",
          APPLICATION_REQUIRED_DOCUMENT_TYPES: "GHANA_CARD_FRONT",
        },
        loadComposition: async () => productionComposition(),
        build: async () => ({ listen }),
      }),
    ).rejects.toThrow("PILOT_GATE_EVIDENCE_FILE_REQUIRED");
    expect(listen).not.toHaveBeenCalled();
  });

  it("allows synthetic signed gates only for explicit test mode", async () => {
    await expect(verifyPilotGates({ environment: "test" })).resolves.toEqual({
      environment: "test",
      synthetic: true,
    });
  });

  it("starts telemetry not-ready until a required dependency is probed", () => {
    expect(createTelemetry().readiness()).toEqual({ status: "not_ready" });
  });

  it("requires a compliance role to list all privacy subjects", async () => {
    const service = createPrivacyService();
    await service.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "ACCESS",
      reason: "private reason",
    });
    const listRequests = service.listRequests as unknown as (
      input: unknown,
    ) => Promise<readonly unknown[]>;
    await expect(listRequests({})).rejects.toMatchObject({
      code: "PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED",
    });
    await expect(
      listRequests({
        actor: { id: "compliance-1", role: "COMPLIANCE_AUDITOR" },
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects mutations after a privacy request reaches a terminal status", async () => {
    const service = createPrivacyService();
    const actor = { id: "compliance-1", role: "COMPLIANCE_OFFICER" };
    const request = await service.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "CORRECTION",
    });
    await service.closeRequest({
      requestId: request.id,
      actor,
      outcome: "REJECTED",
    });
    await expect(
      service.reviewRequest({ requestId: request.id, actor }),
    ).rejects.toMatchObject({
      code: "PRIVACY_REQUEST_TERMINAL",
    });
    await expect(
      service.recordCorrection({
        requestId: request.id,
        subjectId,
        field: "displayName",
        proposedValue: "No reopen",
        reason: "terminal request",
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRIVACY_REQUEST_TERMINAL" });
  });

  it("makes retention policy versions immutable and idempotent only for identical input", async () => {
    const service = createPrivacyService();
    const actor = { id: "compliance-1", role: "DPO" };
    const first = await service.approveRetentionPolicy({
      version: "retention-v1",
      retentionDays: 30,
      actor,
    });
    await expect(
      service.approveRetentionPolicy({
        version: "retention-v1",
        retentionDays: 31,
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRIVACY_RETENTION_POLICY_IMMUTABLE" });
    await expect(
      service.approveRetentionPolicy({
        version: "retention-v1",
        retentionDays: 30,
        actor: { id: "another-compliance", role: "DPO" },
      }),
    ).resolves.toEqual(first);
  });

  it("does not export subject profile data after retention anonymization", async () => {
    const service = createPrivacyService({
      subjectIds: [subjectId],
      now: () => new Date("2026-08-23T00:00:00.000Z"),
      subjectData: () => ({
        profile: { displayName: "Private Person", phoneE164: "+233240000101" },
      }),
    });
    const actor = { id: "compliance-1", role: "DPO" };
    const access = await service.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "ACCESS",
    });
    await service.approveRetentionPolicy({
      version: "retention-v1",
      retentionDays: 1,
      actor,
    });
    await service.applyRetention({
      policyVersion: "retention-v1",
      asOf: new Date("2027-01-01T00:00:00.000Z"),
      actor,
    });
    await expect(
      service.exportSubjectData({ requestId: access.id, subjectId }),
    ).resolves.toMatchObject({ profile: { anonymized: true } });
  });

  it("can enter an API correlation ID into the request context", () => {
    const telemetry =
      createTelemetry() as typeof createTelemetry extends () => infer T
        ? T & { enterCorrelationId(id: string): void }
        : never;
    telemetry.enterCorrelationId("00000000-0000-4000-8000-000000000102");
    expect(telemetry.currentCorrelationId()).toBe(
      "00000000-0000-4000-8000-000000000102",
    );
  });

  it("propagates request correlation into API and durable outbox contexts", async () => {
    const correlationId = "00000000-0000-4000-8000-000000000104";
    const app = fastify({ genReqId: () => correlationId });
    const telemetry = createTelemetry();
    let observedApiCorrelation: string | undefined;
    let observedOutboxCorrelation: string | undefined;
    await registerRequestContext(app, telemetry);
    app.get("/correlation", async () => {
      observedApiCorrelation = telemetry.currentCorrelationId();
      observedOutboxCorrelation = currentOutboxCorrelationId();
      return { ok: true };
    });
    await expect(
      app.inject({ method: "GET", url: "/correlation" }),
    ).resolves.toMatchObject({
      statusCode: 200,
    });
    expect(observedApiCorrelation).toBe(correlationId);
    expect(observedOutboxCorrelation).toBe(correlationId);
    await app.close();
  });
});

function productionComposition() {
  const boundary = createProductionConnectorBoundary();
  const sms = boundary.register({
    kind: "SMS",
    provenance: {
      packageName: "@somo-external/test-sms",
      packageVersion: "1.0.0",
      connectorId: "test-sms",
    },
    adapter: {
      async send() {
        return {
          providerReference: "test-sms-reference",
          acceptedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
  });
  const nia = boundary.register({
    kind: "NIA",
    provenance: {
      packageName: "@somo-external/test-nia",
      packageVersion: "1.0.0",
      connectorId: "test-nia",
    },
    adapter: {
      async verify() {
        return {
          providerReference: "test-nia-reference",
          decision: "REVIEW" as const,
          checkedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    },
  });
  const deliverySecret = "test-production-delivery-secret-at-least-32-chars";
  return {
    sms,
    nia,
    otpPolicy: {
      ttlMs: 120_000,
      attemptLimit: 3,
      resendCooldownMs: 30_000,
      codeLength: 6,
      hashSecret: "test-production-otp-secret-at-least-32-characters",
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
      storage: createS3ObjectStorage({
        endpoint: "https://storage.test.invalid",
        region: "test-1",
        bucket: "test-production",
        accessKeyId: "test-access-key",
        secretAccessKey: "test-production-secret-at-least-32-characters",
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
  };
}
