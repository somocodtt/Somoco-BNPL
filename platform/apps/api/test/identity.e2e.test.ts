import { createHash, randomUUID } from "node:crypto";
import { Writable } from "node:stream";
import { createDatabase, migrateDatabase, type Database } from "@somo/db";
import {
  openOtpDelivery,
  type NiaPort,
  type SmsPort,
} from "@somo/integrations";
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
  attemptAcceptedDocumentMutation,
  attemptConsentEvidenceMutation,
  readAuditEventsForAggregate,
  readConsentEvidence,
  readIdentityChecks,
  readLatestOtpChallenge,
  readOtpDeliveryPayloads,
  readOtpRequestWorkEvidence,
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
  deliveryEncryptionSecret:
    "test-otp-delivery-secret-with-at-least-32-characters",
  sessionTtlMs: 3_600_000,
};

const consentCatalogV1 = {
  documents: [
    {
      purpose: "NIA_IDENTITY_VERIFICATION",
      currentVersion: "nia-consent-v1",
    },
  ],
} as const;

const consentCatalogV2 = {
  documents: [
    {
      purpose: "NIA_IDENTITY_VERIFICATION",
      currentVersion: "nia-consent-v2",
    },
  ],
} as const;

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
        code: await latestOtpCode(),
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
    const firstCode = await latestOtpCode();
    clock.advance(otpPolicy.resendCooldownMs + 1);
    await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });
    const secondCode = await latestOtpCode();

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
        code: await latestOtpCode(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });
  });

  it("keeps resend cooldown after attempt exhaustion", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000108",
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
    for (let attempt = 0; attempt < otpPolicy.attemptLimit; attempt += 1) {
      await expect(
        service.verify({
          phoneE164: person.phoneE164,
          code: "000000",
          requestId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });
    }

    await service.request({
      phoneE164: person.phoneE164,
      requestId: randomUUID(),
    });

    expect(await readOtpDeliveryPayloads(databaseUrl)).toHaveLength(1);
  });

  it("returns without awaiting SMS delivery and equalizes request persistence work", async () => {
    const gate = deferredSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000109",
    });
    const service = createOtpService({
      database,
      sms: gate.sms,
      policy: otpPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    const knownRequestId = randomUUID();
    const unknownRequestId = randomUUID();
    let knownSettled = false;
    const knownRequest = service
      .request({ phoneE164: person.phoneE164, requestId: knownRequestId })
      .then(() => {
        knownSettled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 75));
    const settledBeforeDelivery = knownSettled;
    gate.release();
    await knownRequest;
    await service.request({
      phoneE164: "+233200009998",
      requestId: unknownRequestId,
    });

    expect(settledBeforeDelivery).toBe(true);
    expect(gate.sendCount()).toBe(0);
    expect(
      await readOtpRequestWorkEvidence(databaseUrl, knownRequestId),
    ).toEqual({
      auditCount: 1,
      outboxCount: 1,
    });
    expect(
      await readOtpRequestWorkEvidence(databaseUrl, unknownRequestId),
    ).toEqual({
      auditCount: 1,
      outboxCount: 1,
    });
  });

  it("equalizes failed verification persistence for known and unknown targets", async () => {
    const sms = recordingSms();
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000110",
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
    const knownRequestId = randomUUID();
    const unknownRequestId = randomUUID();
    await expect(
      service.verify({
        phoneE164: person.phoneE164,
        code: "000000",
        requestId: knownRequestId,
      }),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });
    await expect(
      service.verify({
        phoneE164: "+233200009997",
        code: "000000",
        requestId: unknownRequestId,
      }),
    ).rejects.toMatchObject({ code: "OTP_VERIFICATION_FAILED" });

    expect(
      await readOtpRequestWorkEvidence(databaseUrl, knownRequestId),
    ).toEqual({
      auditCount: 1,
      outboxCount: 0,
    });
    expect(
      await readOtpRequestWorkEvidence(databaseUrl, unknownRequestId),
    ).toEqual({
      auditCount: 1,
      outboxCount: 0,
    });
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
    expect(await readOtpDeliveryPayloads(databaseUrl)).toHaveLength(1);
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
    const code = await latestOtpCode();
    const deliveryPayloads = await readOtpDeliveryPayloads(databaseUrl);

    expect(stored?.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.codeHash).not.toBe(code);
    expect(JSON.stringify(stored)).not.toContain(code);
    expect(JSON.stringify(deliveryPayloads)).not.toContain(code);
    expect(JSON.stringify(deliveryPayloads)).not.toContain(person.phoneE164);
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
        consentCatalog: consentCatalogV1,
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

  it("promotes clean bytes to immutable evidence and blocks accepted-row mutation", async () => {
    const storage = memoryObjectStorage();
    const service = createDocumentService({
      database,
      storage,
      malwareScanner: recordingMalwareScanner("CLEAN"),
      policy: documentPolicy,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000208",
    });
    const original = pngBytes();
    const ticket = await service.requestUpload({
      personId: person.id,
      documentType: "GHANA_CARD_FRONT",
      mimeType: "image/png",
      sizeBytes: original.byteLength,
      requestId: randomUUID(),
    });
    storage.upload(ticket, original, "image/png");
    await service.completeUpload({
      personId: person.id,
      documentId: ticket.documentId,
      requestId: randomUUID(),
    });

    const replay = Uint8Array.from(original, (byte, index) =>
      index < 8 ? byte : byte ^ 0xff,
    );
    storage.upload(ticket, replay, "image/png");
    const download = await service.requestDownload({
      personId: person.id,
      documentId: ticket.documentId,
      requestId: randomUUID(),
    });

    expect(storage.downloadBytes(download.downloadUrl)).toEqual(original);
    await expect(
      attemptAcceptedDocumentMutation(databaseUrl, ticket.documentId, "UPDATE"),
    ).resolves.toBe("55000");
    await expect(
      attemptAcceptedDocumentMutation(databaseUrl, ticket.documentId, "DELETE"),
    ).resolves.toBe("55000");
  });
});

describe("NIA verification and consent evidence", () => {
  it("rejects invented, stale, and wrong-purpose consent documents", async () => {
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000306",
    });
    const service = createConsentService({
      database,
      catalog: consentCatalogV2,
      clock: mutableClock("2026-08-14T12:00:00.000Z"),
    });
    const common = {
      subjectPersonId: person.id,
      phoneE164: person.phoneE164,
      sessionId: randomUUID(),
      ipAddress: "192.0.2.36",
      userAgent: "Synthetic Customer Test/1.0",
      requestId: randomUUID(),
    };

    for (const document of [
      { purpose: "NIA_IDENTITY_VERIFICATION", documentVersion: "invented-v99" },
      {
        purpose: "NIA_IDENTITY_VERIFICATION",
        documentVersion: "nia-consent-v1",
      },
      { purpose: "CREDIT_BUREAU_CHECK", documentVersion: "nia-consent-v2" },
    ]) {
      await expect(
        service.record({ ...common, ...document }),
      ).rejects.toMatchObject({
        code: "CONSENT_DOCUMENT_NOT_APPROVED",
      });
    }
    expect(await readConsentEvidence(databaseUrl, person.id)).toEqual([]);
  });

  it("reserves one stable NIA correlation before outage and reuses it on retry", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000307",
    });
    const consent = await recordNiaConsent(person, clock);
    const correlations: string[] = [];
    let unavailable = true;
    const service = createNiaService({
      database,
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
      nia: {
        async verify(input) {
          correlations.push(input.correlationId);
          if (unavailable) {
            unavailable = false;
            throw new Error("synthetic outage");
          }
          return {
            providerReference: "nia-recovered-1",
            decision: "MATCH",
            checkedAt: "2026-08-14T12:00:01.000Z",
          };
        },
      },
      clock,
    });
    const request = {
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000007-7",
      idempotencyKey: randomUUID(),
      sessionId: consent.sessionId,
      requestId: randomUUID(),
    };

    await expect(service.verifyGhanaCard(request)).rejects.toMatchObject({
      code: "NIA_UNAVAILABLE",
    });
    expect(await readIdentityChecks(databaseUrl, person.id)).toMatchObject([
      {
        status: "PENDING",
        providerReference: null,
        consentEvidenceId: consent.consentId,
      },
    ]);
    const recovered = await service.verifyGhanaCard({
      ...request,
      requestId: randomUUID(),
    });
    expect(correlations).toEqual([correlations[0], correlations[0]]);
    expect(recovered.identityCheckId).toBe(correlations[0]);
  });

  it("coalesces concurrent duplicate NIA requests into one provider call", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000308",
    });
    const consent = await recordNiaConsent(person, clock);
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createNiaService({
      database,
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
      nia: {
        async verify() {
          calls += 1;
          await gate;
          return {
            providerReference: "nia-concurrent-1",
            decision: "MATCH",
            checkedAt: "2026-08-14T12:00:01.000Z",
          };
        },
      },
      clock,
    });
    const request = {
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000008-8",
      idempotencyKey: randomUUID(),
      sessionId: consent.sessionId,
      requestId: randomUUID(),
    };
    const first = service.verifyGhanaCard(request);
    const duplicate = service.verifyGhanaCard({
      ...request,
      requestId: randomUUID(),
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    release();
    const results = await Promise.allSettled([first, duplicate]);

    expect(calls).toBe(1);
    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "fulfilled" });
    if (
      results[0]?.status === "fulfilled" &&
      results[1]?.status === "fulfilled"
    ) {
      expect(results[0].value.identityCheckId).toBe(
        results[1].value.identityCheckId,
      );
    }
  });

  it("returns the recorded result when the provider repeats a reference", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000309",
    });
    const consent = await recordNiaConsent(person, clock);
    const service = createNiaService({
      database,
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
      nia: deterministicNia("MATCH", "nia-provider-duplicate-1"),
      clock,
    });
    const common = {
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000009-9",
      sessionId: consent.sessionId,
    };
    const first = await service.verifyGhanaCard({
      ...common,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    const duplicate = await service.verifyGhanaCard({
      ...common,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });

    expect(duplicate.identityCheckId).toBe(first.identityCheckId);
  });

  it("binds a NIA idempotency key to the original minimized request", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000310",
    });
    const consent = await recordNiaConsent(person, clock);
    let calls = 0;
    const service = createNiaService({
      database,
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
      nia: {
        async verify() {
          calls += 1;
          return {
            providerReference: "nia-idempotency-bound-1",
            decision: "MATCH",
            checkedAt: "2026-08-14T12:00:01.000Z",
          };
        },
      },
      clock,
    });
    const idempotencyKey = randomUUID();
    await service.verifyGhanaCard({
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000010-0",
      idempotencyKey,
      sessionId: consent.sessionId,
      requestId: randomUUID(),
    });

    await expect(
      service.verifyGhanaCard({
        subjectPersonId: person.id,
        consentId: consent.consentId,
        ghanaCardNumber: "GHA-000000011-1",
        idempotencyKey,
        sessionId: consent.sessionId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "NIA_IDEMPOTENCY_CONFLICT" });
    expect(calls).toBe(1);
  });
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
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
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
        idempotencyKey: randomUUID(),
        sessionId: consent.sessionId,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 503, code: "NIA_UNAVAILABLE" });

    await expect(readSyntheticDraft(databaseUrl, draft.id)).resolves.toEqual({
      id: draft.id,
      status: "DRAFT",
      version: 1,
    });
    expect(await readIdentityChecks(databaseUrl, person.id)).toMatchObject([
      {
        status: "PENDING",
        providerReference: null,
        consentEvidenceId: consent.consentId,
      },
    ]);
  });

  it("maps NO_MATCH to failed and cannot produce verified state", async () => {
    const clock = mutableClock("2026-08-14T12:00:00.000Z");
    const person = await seedSyntheticPerson(databaseUrl, {
      phoneE164: "+233200000302",
    });
    const consent = await recordNiaConsent(person, clock);
    const service = createNiaService({
      database,
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
      nia: deterministicNia("NO_MATCH", "nia-no-match-1"),
      clock,
    });

    const result = await service.verifyGhanaCard({
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000002-2",
      idempotencyKey: randomUUID(),
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
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
      nia: deterministicNia("REVIEW", "nia-review-1"),
      clock,
    });

    const result = await service.verifyGhanaCard({
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber: "GHA-000000003-3",
      idempotencyKey: randomUUID(),
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
    const service = createNiaService({
      database,
      nia: provider,
      catalog: consentCatalogV1,
      idempotencyHashSecret: otpPolicy.hashSecret,
      clock,
    });

    const result = await service.verifyGhanaCard({
      subjectPersonId: person.id,
      consentId: consent.consentId,
      ghanaCardNumber,
      idempotencyKey: randomUUID(),
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
        consentEvidenceId: consent.consentId,
        status: "VERIFIED",
        evidence: {
          decision: "MATCH",
          purpose: "NIA_IDENTITY_VERIFICATION",
          consentEvidenceId: consent.consentId,
        },
      },
    ]);
    expect(audits).toEqual([
      {
        action: "NIA_IDENTITY_CHECK_RESERVED",
        data: {
          subjectPersonId: person.id,
          purpose: "NIA_IDENTITY_VERIFICATION",
          consentEvidenceId: consent.consentId,
          customerSessionId: consent.sessionId,
        },
      },
      {
        action: "NIA_IDENTITY_CHECK_RECORDED",
        data: {
          subjectPersonId: person.id,
          purpose: "NIA_IDENTITY_VERIFICATION",
          consentEvidenceId: consent.consentId,
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
    const service = createConsentService({
      database,
      catalog: consentCatalogV1,
      clock,
    });
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
    const second = await createConsentService({
      database,
      catalog: consentCatalogV2,
      clock,
    }).record({
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
        consentCatalog: consentCatalogV1,
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
        payload: {
          phoneE164: person.phoneE164,
          code: await latestOtpCode(),
        },
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
          idempotencyKey: randomUUID(),
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

  it("uses actual runtime NODE_ENV for production startup validation", async () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      await expect(
        buildApp({ config: testConfig, database, logger: false }),
      ).rejects.toThrow("PRODUCTION_IDENTITY_DEPENDENCIES_REQUIRED");
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
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
        identity: {
          sms: recordingSms(),
          otpPolicy,
          consentCatalog: consentCatalogV1,
        },
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
          consentCatalog: consentCatalogV1,
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
  return createConsentService({
    database,
    catalog: consentCatalogV1,
    clock,
  }).record({
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

function recordingSms(): SmsPort {
  return {
    async send() {
      throw new Error("OTP_DELIVERY_MUST_USE_OUTBOX");
    },
  };
}

function deferredSms() {
  let release!: () => void;
  let sends = 0;
  const delivery = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    sms: {
      async send() {
        sends += 1;
        await delivery;
        return {
          providerReference: "sms-deferred-1",
          acceptedAt: "2026-08-14T12:00:00.000Z",
        };
      },
    } satisfies SmsPort,
    release,
    sendCount: () => sends,
  };
}

async function latestOtpCode(): Promise<string> {
  const payloads = await readOtpDeliveryPayloads(testConfig.databaseUrl);
  const latest = payloads.at(-1);
  if (
    typeof latest !== "object" ||
    latest === null ||
    !("delivery" in latest)
  ) {
    throw new Error("OTP_DELIVERY_NOT_QUEUED");
  }
  return openOtpDelivery(
    otpPolicy.deliveryEncryptionSecret,
    (latest as { delivery: unknown }).delivery,
  ).variables.code;
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
    versionId: string;
    etag: string;
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
        versionId: object.versionId,
        etag: object.etag,
      };
    },
    async promoteToImmutable(input: {
      stagingObjectKey: string;
      stagingVersionId: string;
      stagingEtag: string;
      immutableObjectKey: string;
    }) {
      const staging = objects.get(input.stagingObjectKey);
      if (
        staging === undefined ||
        staging.versionId !== input.stagingVersionId ||
        staging.etag !== input.stagingEtag
      ) {
        throw new Error("STAGING_IDENTITY_MISMATCH");
      }
      const immutable = {
        ...staging,
        bytes: Uint8Array.from(staging.bytes),
        versionId: randomUUID(),
      };
      objects.set(input.immutableObjectKey, immutable);
      return {
        objectKey: input.immutableObjectKey,
        versionId: immutable.versionId,
        etag: immutable.etag,
      };
    },
    async createDownloadTicket(input: {
      objectKey: string;
      versionId: string;
      etag: string;
      expiresAt: Date;
    }) {
      const object = objects.get(input.objectKey);
      if (
        object === undefined ||
        object.versionId !== input.versionId ||
        object.etag !== input.etag
      ) {
        throw new Error("IMMUTABLE_IDENTITY_MISMATCH");
      }
      downloads += 1;
      return {
        downloadUrl: `fake://download/${input.objectKey}`,
        expiresAt: input.expiresAt.toISOString(),
        requiredHeaders: { "if-match": input.etag },
      };
    },
    downloadBytes(downloadUrl: string) {
      const objectKey = downloadUrl.replace("fake://download/", "");
      const object = objects.get(objectKey);
      if (object === undefined) throw new Error("OBJECT_NOT_FOUND");
      return object.bytes;
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
      objects.set(objectKey, {
        bytes,
        contentType,
        metadata,
        versionId: randomUUID(),
        etag: createHash("sha256").update(bytes).digest("hex"),
      });
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
