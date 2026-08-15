import { randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createDatabase, migrateDatabase, type Database } from "@somo/db";
import type { NiaPort, SmsPort } from "@somo/integrations";
import { createNiaSimulator } from "@somo/integrations/simulators";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  createOtpService,
  type OtpPolicy,
} from "../src/modules/identity/otp-service.js";
import {
  createDocumentService,
  type DocumentPolicy,
} from "../src/modules/documents/service.js";
import { createConsentService } from "../src/modules/identity/consent-service.js";
import { createNiaService } from "../src/modules/identity/nia-service.js";
import {
  attemptConsentEvidenceMutation,
  readAuditEventsForAggregate,
  readConsentEvidence,
  readIdentityChecks,
  readLatestOtpChallenge,
  readSyntheticDraft,
  resetTestDatabase,
  seedSyntheticDraft,
  seedSyntheticPerson,
} from "../../../packages/testkit/src/database.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required for API integration tests");
}

const testConfig: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl,
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

const otpPolicy: OtpPolicy = {
  ttlMs: 120_000,
  attemptLimit: 3,
  resendCooldownMs: 30_000,
  codeLength: 6,
  hashSecret: "test-otp-hash-secret-with-at-least-32-characters",
  sessionTtlMs: 3_600_000,
};

let database: Database;
let closeDatabase: () => Promise<void>;

beforeAll(async () => {
  await resetTestDatabase(databaseUrl);
  const connection = createDatabase(databaseUrl);
  database = connection.db;
  closeDatabase = connection.close;
  await migrateDatabase(database);
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl);
  await migrateDatabase(database);
});

afterAll(async () => {
  await closeDatabase();
});

describe("SMS OTP abuse controls", () => {
  it("rejects an expired code", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000101",
    });
    const service = createOtpService({
      database,
      sms,
      policy: otpPolicy,
      clock,
    });

    await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });
    clock.advance(otpPolicy.ttlMs + 1);

    await expect(
      service.verify({
        phoneE164: person.phoneE164,
        code: sms.lastCode(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });
  });

  it("invalidates every outstanding code after one successful verification", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000102",
    });
    const service = createOtpService({
      database,
      sms,
      policy: otpPolicy,
      clock,
    });

    await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });
    const firstCode = sms.lastCode();
    clock.advance(otpPolicy.resendCooldownMs + 1);
    await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });
    const secondCode = sms.lastCode();

    await expect(
      service.verify({
        phoneE164: person.phoneE164,
        code: secondCode,
        requestId: randomUUID(),
      }),
    ).resolves.toMatchObject({ verified: true, personId: person.id });
    await expect(
      service.verify({
        phoneE164: person.phoneE164,
        code: firstCode,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });
  });

  it("invalidates a challenge at the configured attempt limit", async () => {
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000103",
    });
    const service = createOtpService({
      database,
      sms,
      policy: otpPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });

    for (let attempt = 0; attempt < otpPolicy.attemptLimit; attempt += 1) {
      await expect(
        service.verify({
          phoneE164: person.phoneE164,
          code: "000000",
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });
    }
    await expect(
      service.verify({
        phoneE164: person.phoneE164,
        code: sms.lastCode(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });
  });

  it("does not send another code inside the configured resend cooldown", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000104",
    });
    const service = createOtpService({
      database,
      sms,
      policy: otpPolicy,
      clock,
    });

    const first = await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });
    clock.advance(otpPolicy.resendCooldownMs - 1);
    const repeated = await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });

    expect(first).toEqual({ accepted: true });
    expect(repeated).toEqual(first);
    expect(sms.sendCount()).toBe(1);
  });

  it("persists only a keyed hash of the generated code", async () => {
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000105",
    });
    const service = createOtpService({
      database,
      sms,
      policy: otpPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });

    await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });
    const stored = await readLatestOtpChallenge(databaseUrl, person.id);

    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.codeHash).not.toBe(sms.lastCode());
    expect(JSON.stringify(stored)).not.toContain(sms.lastCode());
  });

  it("returns the same request response for an unknown and known phone", async () => {
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000106",
    });
    const service = createOtpService({
      database,
      sms,
      policy: otpPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });

    const known = await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });
    const unknown = await service.request({
      phoneE164: "+233200009999",
      requestId: randomUUID(),
    });

    expect(unknown).toEqual(known);
  });

  it("redacts phone numbers and OTP codes from structured logs", async () => {
    let logs = "";
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        logs += chunk.toString();
        callback();
      },
    });
    const app = await buildApp({
      config: testConfig,
      database,
      loggerStream: stream,
      identity: {
        sms: recordingSms(),
        otpPolicy,
      },
    });
    app.log.info(
      {
        body: {
          phoneE164: "+233200000107",
          code: "719204",
        },
      },
      "OTP redaction probe",
    );

    await app.close();

    expect(logs).toContain("[REDACTED]");
    expect(logs).not.toContain("+233200000107");
    expect(logs).not.toContain("719204");
  });
});

const documentPolicy: DocumentPolicy = {
  allowedMimeTypes: ["application/pdf", "image/jpeg", "image/png"],
  maxBytes: 1_024,
  uploadTtlMs: 60_000,
  downloadTtlMs: 30_000,
};

describe("document upload security", () => {
  it("rejects a disallowed declared MIME type before issuing a ticket", async () => {
    const storage = memoryObjectStorage();
    const service = createDocumentService({
      database,
      storage,
      malwareScanner: recordingMalwareScanner("CLEAN"),
      policy: documentPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000201",
    });

    await expect(
      service.requestUpload({
        personId: person.id,
        documentType: "GHANA_CARD_FRONT",
        mimeType: "text/html",
        sizeBytes: 128,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_TYPE_NOT_ALLOWED" });
    expect(storage.uploadTicketCount()).toBe(0);
  });

  it("rejects an excessive declared size before issuing a ticket", async () => {
    const storage = memoryObjectStorage();
    const service = createDocumentService({
      database,
      storage,
      malwareScanner: recordingMalwareScanner("CLEAN"),
      policy: documentPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000202",
    });

    await expect(
      service.requestUpload({
        personId: person.id,
        documentType: "GHANA_CARD_FRONT",
        mimeType: "image/png",
        sizeBytes: documentPolicy.maxBytes + 1,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_TOO_LARGE" });
    expect(storage.uploadTicketCount()).toBe(0);
  });

  it("rejects bytes whose magic type does not match the declared MIME type", async () => {
    const storage = memoryObjectStorage();
    const service = createDocumentService({
      database,
      storage,
      malwareScanner: recordingMalwareScanner("CLEAN"),
      policy: documentPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000203",
    });
    const ticket = await service.requestUpload({
      personId: person.id,
      documentType: "GHANA_CARD_FRONT",
      mimeType: "image/jpeg",
      sizeBytes: pngBytes().byteLength,
      requestId: randomUUID(),
    });
    storage.upload(ticket, pngBytes(), "image/jpeg");

    await expect(
      service.completeUpload({
        personId: person.id,
        documentId: ticket.documentId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_CONTENT_TYPE_MISMATCH" });
    await expect(
      service.requestDownload({
        personId: person.id,
        documentId: ticket.documentId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_READY" });
  });

  it("quarantines malware and never exposes a download", async () => {
    const storage = memoryObjectStorage();
    const scanner = recordingMalwareScanner("INFECTED");
    const service = createDocumentService({
      database,
      storage,
      malwareScanner: scanner,
      policy: documentPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000204",
    });
    const bytes = pngBytes();
    const ticket = await service.requestUpload({
      personId: person.id,
      documentType: "GHANA_CARD_FRONT",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      requestId: randomUUID(),
    });
    storage.upload(ticket, bytes, "image/png");

    await expect(
      service.completeUpload({
        personId: person.id,
        documentId: ticket.documentId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_MALWARE_DETECTED" });
    await expect(
      service.requestDownload({
        personId: person.id,
        documentId: ticket.documentId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_NOT_READY" });
    expect(scanner.scanCount()).toBe(1);
    expect(storage.downloadTicketCount()).toBe(0);
  });

  it("rejects completion after the bound upload ticket expires", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const storage = memoryObjectStorage();
    const scanner = recordingMalwareScanner("CLEAN");
    const service = createDocumentService({
      database,
      storage,
      malwareScanner: scanner,
      policy: documentPolicy,
      clock,
    });
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000205",
    });
    const bytes = pngBytes();
    const ticket = await service.requestUpload({
      personId: person.id,
      documentType: "GHANA_CARD_FRONT",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      requestId: randomUUID(),
    });
    storage.upload(ticket, bytes, "image/png");
    clock.advance(documentPolicy.uploadTtlMs + 1);

    await expect(
      service.completeUpload({
        personId: person.id,
        documentId: ticket.documentId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DOCUMENT_UPLOAD_EXPIRED" });
    expect(scanner.scanCount()).toBe(0);
  });

  it("returns the same non-enumerating denial for another user's document", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const storage = memoryObjectStorage();
    const service = createDocumentService({
      database,
      storage,
      malwareScanner: recordingMalwareScanner("CLEAN"),
      policy: documentPolicy,
      clock,
    });
    const owner = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000206",
    });
    const other = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000207",
    });
    const bytes = pngBytes();
    const ticket = await service.requestUpload({
      personId: owner.id,
      documentType: "GHANA_CARD_FRONT",
      mimeType: "image/png",
      sizeBytes: bytes.byteLength,
      requestId: randomUUID(),
    });
    storage.upload(ticket, bytes, "image/png");
    await service.completeUpload({
      personId: owner.id,
      documentId: ticket.documentId,
      requestId: randomUUID(),
    });

    const crossUser = service.requestDownload({
      personId: other.id,
      documentId: ticket.documentId,
      requestId: randomUUID(),
    });
    const absent = service.requestDownload({
      personId: other.id,
      documentId: randomUUID(),
      requestId: randomUUID(),
    });
    await expect(crossUser).rejects.toMatchObject({
      statusCode: 404,
      code: "DOCUMENT_NOT_FOUND",
      publicDetail: "Document was not found.",
    });
    await expect(absent).rejects.toMatchObject({
      statusCode: 404,
      code: "DOCUMENT_NOT_FOUND",
      publicDetail: "Document was not found.",
    });
    expect(storage.downloadTicketCount()).toBe(0);

    const ownerDownload = await service.requestDownload({
      personId: owner.id,
      documentId: ticket.documentId,
      requestId: randomUUID(),
    });
    expect(ownerDownload.downloadUrl).toContain("fake://download/");
    expect(new Date(ownerDownload.expiresAt).getTime()).toBe(
      clock.now().getTime() + documentPolicy.downloadTtlMs,
    );
  });
});

describe("NIA verification and consent evidence", () => {
  it("preserves a saved application draft when NIA is unavailable", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000301",
    });
    const draft = await seedSyntheticDraft(databaseUrl, {
      personId: person.id,
    });
    const consent = await recordNiaConsent(person, clock);
    const service = createNiaService({
      database,
      nia: {
        async verify() {
          throw new Error("provider payload with sensitive diagnostics");
        },
      },
      clock,
    });

    await expect(
      service.verifyGhanaCard({
        subjectPersonId: person.id,
        consentId: consent.consentId,
        ghanaCardNumber: "GHA-000000001-1",
        sessionId: consent.sessionId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "NIA_UNAVAILABLE" });

    await expect(readSyntheticDraft(databaseUrl, draft.id)).resolves.toEqual({
      id: draft.id,
      status: "DRAFT",
      version: 1,
    });
    expect(await readIdentityChecks(databaseUrl, person.id)).toEqual([]);
  });

  it("maps NO_MATCH to failed and cannot produce verified state", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000302",
    });
    const consent = await recordNiaConsent(person, clock);
    const service = createNiaService({
      database,
      nia: deterministicNia("NO_MATCH", "nia-no-match-1"),
      clock,
    });

    const result = await service.verifyGhanaCard({
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000002-2",
      sessionId: consent.sessionId,
      requestId: randomUUID(),
    });

    expect(result).toMatchObject({ status: "FAILED", decision: "NO_MATCH" });
    expect(result.status).not.toBe("VERIFIED");
    expect(await readIdentityChecks(databaseUrl, person.id)).toMatchObject([
      {
        status: "FAILED",
        provider: "NIA",
        providerReference: "nia-no-match-1",
        evidence: {
          decision: "NO_MATCH",
          purpose: "NIA_IDENTITY_VERIFICATION",
        },
      },
    ]);
  });

  it("maps REVIEW to manual review rather than verified", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000303",
    });
    const consent = await recordNiaConsent(person, clock);
    const service = createNiaService({
      database,
      nia: deterministicNia("REVIEW", "nia-review-1"),
      clock,
    });

    const result = await service.verifyGhanaCard({
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000003-3",
      sessionId: consent.sessionId,
      requestId: randomUUID(),
    });

    expect(result).toMatchObject({
      status: "MANUAL_REVIEW",
      decision: "REVIEW",
    });
    expect(result.status).not.toBe("VERIFIED");
  });

  it("persists and audits only the minimum successful NIA result", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000304",
    });
    const consent = await recordNiaConsent(person, clock);
    const ghanaCardNumber = "GHA-000000004-4";
    const provider = {
      async verify() {
        return {
          providerReference: "nia-match-1",
          decision: "MATCH" as const,
          checkedAt: "2026-08-14T12:00:01.000Z",
          biometricTemplate: "synthetic-face-template",
          rawProviderPayload: { score: 0.999 },
        };
      },
    } satisfies NiaPort;
    const service = createNiaService({ database, nia: provider, clock });

    const result = await service.verifyGhanaCard({
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber,
      sessionId: consent.sessionId,
      requestId: randomUUID(),
    });
    const checks = await readIdentityChecks(databaseUrl, person.id);
    const audits = await readAuditEventsForAggregate(
      databaseUrl,
      "identity_check",
      result.identityCheckId,
    );
    const persisted = JSON.stringify({ checks, audits });

    expect(result).toMatchObject({
      status: "VERIFIED",
      decision: "MATCH",
      providerReference: "nia-match-1",
      checkedAt: "2026-08-14T12:00:01.000Z",
    });
    expect(checks).toMatchObject([
      {
        id: result.identityCheckId,
        personId: person.id,
        provider: "NIA",
        providerReference: "nia-match-1",
        status: "VERIFIED",
        evidence: {
          decision: "MATCH",
          purpose: "NIA_IDENTITY_VERIFICATION",
        },
      },
    ]);
    expect(audits).toEqual([
      {
        action: "NIA_IDENTITY_CHECK_RECORDED",
        data: {
          subjectPersonId: person.id,
          purpose: "NIA_IDENTITY_VERIFICATION",
          providerReference: "nia-match-1",
          decision: "MATCH",
          checkedAt: "2026-08-14T12:00:01.000Z",
          customerSessionId: consent.sessionId,
        },
      },
    ]);
    expect(persisted).not.toContain(ghanaCardNumber);
    expect(persisted).not.toContain("synthetic-face-template");
    expect(persisted).not.toContain("rawProviderPayload");
  });

  it("records immutable consent evidence as distinct document versions", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000305",
    });
    const service = createConsentService({ database, clock });
    const common = {
      subjectPersonId: person.id,
      purpose: "NIA_IDENTITY_VERIFICATION",
      phoneE164: person.phoneE164,
      sessionId: randomUUID(),
      ipAddress: "192.0.2.35",
      userAgent: "Synthetic Customer Test/1.0",
    } as const;
    const first = await service.record({
      ...common,
      documentVersion: "nia-consent-v1",
      requestId: randomUUID(),
    });
    clock.advance(1_000);
    const second = await service.record({
      ...common,
      documentVersion: "nia-consent-v2",
      requestId: randomUUID(),
    });

    expect(first.consentId).not.toBe(second.consentId);
    expect(first.documentVersion).toBe("nia-consent-v1");
    expect(second.documentVersion).toBe("nia-consent-v2");
    expect(await readConsentEvidence(databaseUrl, person.id)).toMatchObject([
      {
        id: first.consentId,
        documentVersion: "nia-consent-v1",
        purpose: "NIA_IDENTITY_VERIFICATION",
      },
      {
        id: second.consentId,
        documentVersion: "nia-consent-v2",
        purpose: "NIA_IDENTITY_VERIFICATION",
      },
    ]);
    await expect(
      attemptConsentEvidenceMutation(databaseUrl, first.consentId, "UPDATE"),
    ).resolves.toBe("55000");
    await expect(
      attemptConsentEvidenceMutation(databaseUrl, first.consentId, "DELETE"),
    ).resolves.toBe("55000");
  });
});

describe("customer identity and document routes", () => {
  it("binds authenticated customer routes to the OTP session subject", async () => {
    const sms = recordingSms();
    const storage = memoryObjectStorage();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000401",
    });
    const app = await buildApp({
      config: testConfig,
      database,
      logger: false,
      identity: {
        sms,
        otpPolicy,
        nia: deterministicNia("MATCH", "nia-route-match-1"),
        documents: {
          storage,
          malwareScanner: recordingMalwareScanner("CLEAN"),
          policy: documentPolicy,
        },
      },
    });
    try {
      const requested = await app.inject({
        method: "POST",
        url: "/v1/customer/otp/requests",
        payload: { phoneE164: person.phoneE164 },
      });
      expect(requested.statusCode).toBe(202);
      expect(requested.json()).toEqual({ accepted: true });

      const verified = await app.inject({
        method: "POST",
        url: "/v1/customer/otp/verifications",
        payload: { phoneE164: person.phoneE164, code: sms.lastCode() },
      });
      expect(verified.statusCode).toBe(201);
      const session = verified.json<{
        personId: string;
        sessionToken: string;
      }>();
      expect(session.personId).toBe(person.id);
      const authorization = `Bearer ${session.sessionToken}`;

      const consentResponse = await app.inject({
        method: "POST",
        url: "/v1/customer/consents",
        headers: {
          authorization,
          "user-agent": "Synthetic Route Test/1.0",
        },
        payload: {
          purpose: "NIA_IDENTITY_VERIFICATION",
          documentVersion: "nia-consent-v1",
          phoneE164: person.phoneE164,
        },
      });
      expect(consentResponse.statusCode).toBe(201);
      const consent = consentResponse.json<{ consentId: string }>();

      const niaResponse = await app.inject({
        method: "POST",
        url: "/v1/customer/identity/ghana-card-verifications",
        headers: { authorization },
        payload: {
          consentId: consent.consentId,
          ghanaCardNumber: "GHA-000000401-1",
        },
      });
      expect(niaResponse.statusCode).toBe(201);
      expect(niaResponse.json()).toMatchObject({
        status: "VERIFIED",
        decision: "MATCH",
      });

      const bytes = pngBytes();
      const uploadResponse = await app.inject({
        method: "POST",
        url: "/v1/customer/documents/uploads",
        headers: { authorization },
        payload: {
          documentType: "GHANA_CARD_FRONT",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        },
      });
      expect(uploadResponse.statusCode).toBe(201);
      const ticket = uploadResponse.json<{
        documentId: string;
        uploadUrl: string;
        requiredHeaders: Readonly<Record<string, string>>;
      }>();
      storage.upload(ticket, bytes, "image/png");

      const completeResponse = await app.inject({
        method: "POST",
        url: `/v1/customer/documents/${ticket.documentId}/complete`,
        headers: { authorization },
      });
      expect(completeResponse.statusCode).toBe(200);
      expect(completeResponse.json()).toMatchObject({ status: "ACCEPTED" });

      const downloadResponse = await app.inject({
        method: "GET",
        url: `/v1/customer/documents/${ticket.documentId}/download`,
        headers: { authorization },
      });
      expect(downloadResponse.statusCode).toBe(200);
      expect(downloadResponse.json()).toMatchObject({
        downloadUrl: expect.stringContaining("fake://download/"),
      });
    } finally {
      await app.close();
    }
  });

  it("fails startup when production identity dependencies are absent", async () => {
    await expect(
      buildApp({
        config: {
          ...testConfig,
          environment: "production",
          port: 443,
          requireVerifiedMfa: true,
        },
        database,
        logger: false,
      }),
    ).rejects.toThrow("PRODUCTION_IDENTITY_DEPENDENCIES_REQUIRED");
  });

  it("rejects partially configured production identity dependencies", async () => {
    await expect(
      buildApp({
        config: {
          ...testConfig,
          environment: "production",
          port: 443,
          requireVerifiedMfa: true,
        },
        database,
        logger: false,
        identity: { sms: recordingSms(), otpPolicy },
      }),
    ).rejects.toThrow("PRODUCTION_IDENTITY_DEPENDENCIES_REQUIRED");
  });

  it("fails closed when a simulator is injected into production", async () => {
    await expect(
      buildApp({
        config: {
          ...testConfig,
          environment: "production",
          port: 443,
          requireVerifiedMfa: true,
        },
        database,
        logger: false,
        identity: {
          sms: recordingSms(),
          otpPolicy,
          nia: createNiaSimulator({ environment: "test", fixtures: [] }),
          documents: {
            storage: memoryObjectStorage(),
            malwareScanner: recordingMalwareScanner("CLEAN"),
            policy: documentPolicy,
          },
        },
      }),
    ).rejects.toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
  });
});

async function recordNiaConsent(
  person: { id: string; phoneE164: string },
  clock: ReturnType<typeof mutableClock>,
) {
  return createConsentService({ database, clock }).record({
    subjectPersonId: person.id,
    purpose: "NIA_IDENTITY_VERIFICATION",
    documentVersion: "nia-consent-v1",
    phoneE164: person.phoneE164,
    sessionId: randomUUID(),
    ipAddress: "192.0.2.10",
    userAgent: "Synthetic Customer Test/1.0",
    requestId: randomUUID(),
  });
}

function deterministicNia(
  decision: "MATCH" | "NO_MATCH" | "REVIEW",
  providerReference: string,
): NiaPort {
  return {
    async verify() {
      return {
        providerReference,
        decision,
        checkedAt: "2026-08-14T12:00:01.000Z",
      };
    },
  };
}

function mutableClock(initial: string) {
  let now = new Date(initial);
  return {
    now: () => new Date(now),
    advance(milliseconds: number) {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}

function recordingSms(): SmsPort & {
  lastCode(): string;
  sendCount(): number;
} {
  const codes: string[] = [];
  return {
    async send(input) {
      const code = input.variables.code;
      if (code === undefined) throw new Error("OTP_CODE_MISSING");
      codes.push(code);
      return {
        providerReference: `sms-${codes.length}`,
        acceptedAt: "2026-08-14T12:00:00.000Z",
      };
    },
    lastCode() {
      const code = codes.at(-1);
      if (code === undefined) throw new Error("OTP_NOT_SENT");
      return code;
    },
    sendCount() {
      return codes.length;
    },
  };
}

function pngBytes(): Uint8Array {
  return Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  );
}

function memoryObjectStorage() {
  type StoredObject = {
    bytes: Uint8Array;
    contentType: string;
    metadata: Readonly<Record<string, string>>;
  };
  const objects = new Map<string, StoredObject>();
  const ticketInputs: Array<{
    objectKey: string;
    requiredHeaders: Readonly<Record<string, string>>;
  }> = [];
  let downloads = 0;
  return {
    async createUploadTicket(input: {
      objectKey: string;
      expiresAt: Date;
      requiredHeaders: Readonly<Record<string, string>>;
    }) {
      ticketInputs.push({
        objectKey: input.objectKey,
        requiredHeaders: input.requiredHeaders,
      });
      return {
        uploadUrl: `fake://upload/${input.objectKey}`,
        requiredHeaders: input.requiredHeaders,
      };
    },
    async readObject(input: { objectKey: string; maxBytes: number }) {
      const object = objects.get(input.objectKey);
      if (object === undefined) throw new Error("OBJECT_NOT_FOUND");
      if (object.bytes.byteLength > input.maxBytes) {
        throw new Error("OBJECT_TOO_LARGE");
      }
      return {
        bytes: object.bytes,
        contentLength: object.bytes.byteLength,
        contentType: object.contentType,
        metadata: object.metadata,
      };
    },
    async createDownloadTicket(input: { objectKey: string; expiresAt: Date }) {
      downloads += 1;
      return {
        downloadUrl: `fake://download/${input.objectKey}`,
        expiresAt: input.expiresAt.toISOString(),
      };
    },
    upload(
      ticket: {
        uploadUrl: string;
        requiredHeaders: Readonly<Record<string, string>>;
      },
      bytes: Uint8Array,
      contentType: string,
    ) {
      const objectKey = ticket.uploadUrl.replace("fake://upload/", "");
      const metadata = Object.fromEntries(
        Object.entries(ticket.requiredHeaders)
          .filter(([name]) => name.startsWith("x-amz-meta-"))
          .map(([name, value]) => [name.slice("x-amz-meta-".length), value]),
      );
      objects.set(objectKey, { bytes, contentType, metadata });
    },
    uploadTicketCount() {
      return ticketInputs.length;
    },
    downloadTicketCount() {
      return downloads;
    },
  };
}

function recordingMalwareScanner(verdict: "CLEAN" | "INFECTED") {
  let scans = 0;
  return {
    async scan() {
      scans += 1;
      return { verdict, scannerReference: `scan-${scans}` } as const;
    },
    scanCount() {
      return scans;
    },
  };
}
