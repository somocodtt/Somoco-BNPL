import { randomUUID } from "node:crypto";
import { createDatabase, migrateDatabase, type Database } from "@somo/db";
import { otpDerivationKeyId } from "@somo/integrations";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fastify from "fastify";
import {
  createApplicationService,
  type ApplicationContext,
  type ApplicationService,
} from "../src/modules/applications/service.js";
import { registerApplicationRoutes } from "../src/modules/applications/routes.js";
import { registerProblemErrors } from "../src/plugins/errors.js";
import { redactedLogPaths } from "../src/plugins/security.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  readApplicationRow,
  attemptApplicationVersionMutation,
  resetTestDatabase,
  seedApplicationOnboardingFixtures,
  seedCleanDocument,
  seedVerifiedIdentity,
} from "../../../packages/testkit/src/index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required for API integration tests");
}

const guarantorPhone = "+233241000002";
const requiredDocuments = ["GHANA_CARD_FRONT"] as const;

let database: Database;
let closeDatabase: () => Promise<void>;
let service: ApplicationService;
let clock: ReturnType<typeof mutableClock>;
let applicant: ApplicationContext;
let guarantor: ApplicationContext;
let other: ApplicationContext;
let vehicleModelId: string;

beforeAll(async () => {
  const connection = createDatabase(databaseUrl);
  database = connection.db;
  closeDatabase = connection.close;
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl);
  await migrateDatabase(database);
  const fixtures = await seedApplicationOnboardingFixtures();
  applicant = context(fixtures.applicantId);
  guarantor = context(fixtures.guarantorId);
  other = context(fixtures.otherId);
  vehicleModelId = fixtures.vehicleModelId;
  clock = mutableClock("2026-08-17T10:00:00.000Z");
  service = createApplicationService({
    database,
    invitationHashSecret: "task-7-test-invitation-secret-at-least-32-chars",
    invitationTtlMs: 30 * 60_000,
    requiredDocumentTypes: requiredDocuments,
    clock,
  });
});

afterAll(async () => {
  await closeDatabase();
});

describe("application onboarding service", () => {
  it("creates an applicant-owned draft without assigning a vehicle unit", async () => {
    const draft = await service.createDraft(applicant);

    expect(draft).toMatchObject({ status: "DRAFT", version: 1 });
    const persisted = await readApplicationRow<{
      applicant_person_id: string;
      vehicle_model_id: string | null;
      product_id: string | null;
    }>(
      "select applicant_person_id, vehicle_model_id, product_id from application where id = $1",
      [draft.id],
    );
    expect(persisted).toEqual({
      applicant_person_id: applicant.personId,
      vehicle_model_id: null,
      product_id: null,
    });
  });

  it("returns an idempotent autosave result and rejects a stale new mutation", async () => {
    const draft = await service.createDraft(applicant);
    const input = {
      expectedVersion: draft.version,
      mutationId: randomUUID(),
      vehicleModelId,
      profile: { occupation: "Courier", residentialArea: "Dansoman" },
    };

    const saved = await service.saveApplicant(draft.id, applicant, input);
    const retried = await service.saveApplicant(draft.id, applicant, input);

    expect(retried).toEqual(saved);
    await expect(
      service.saveApplicant(draft.id, applicant, {
        ...input,
        mutationId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
  });

  it("resumes only the applicant's latest editable draft and invitation status", async () => {
    const draft = await service.createDraft(applicant);
    const saved = await saveApplicant(draft);
    await service.inviteGuarantor(draft.id, applicant, {
      expectedVersion: saved.version,
      mutationId: randomUUID(),
      guarantorPhoneE164: guarantorPhone,
    });

    await expect(service.resume(applicant)).resolves.toMatchObject({
      draft: {
        id: draft.id,
        status: "AWAITING_GUARANTOR",
        vehicleModelId,
        applicantProfile: {
          occupation: "Courier",
          residentialArea: "Dansoman",
        },
      },
      guarantorStatus: "INVITED",
    });
    await expect(service.resume(other)).resolves.toEqual({
      draft: null,
      guarantorStatus: "NOT_INVITED",
    });
  });

  it("does not disclose or mutate an applicant draft through another customer", async () => {
    const draft = await service.createDraft(applicant);

    await expect(
      service.getCompleteness(draft.id, other),
    ).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND" });
    await expect(
      service.saveApplicant(draft.id, other, {
        expectedVersion: draft.version,
        mutationId: randomUUID(),
        vehicleModelId,
        profile: { occupation: "Trader" },
      }),
    ).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND" });
  });

  it("expires a hashed invitation and allows only the invited customer to claim it", async () => {
    const draft = await service.createDraft(applicant);
    const saved = await saveApplicant(draft);
    const invitation = await service.inviteGuarantor(draft.id, applicant, {
      expectedVersion: saved.version,
      mutationId: randomUUID(),
      guarantorPhoneE164: guarantorPhone,
    });

    const persisted = await readApplicationRow<{ token_hash: string }>(
      "select token_hash from guarantor_invitation where application_id = $1",
      [draft.id],
    );
    expect(persisted.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(persisted.token_hash).not.toContain(invitation.token);
    await expect(
      service.saveGuarantor(invitation.token, other, guarantorSave(1)),
    ).rejects.toMatchObject({ code: "INVITATION_NOT_FOUND" });

    clock.advance(30 * 60_000 + 1);
    await expect(
      service.saveGuarantor(invitation.token, guarantor, guarantorSave(1)),
    ).rejects.toMatchObject({ code: "INVITATION_EXPIRED" });
  });

  it("requires the applicant's own successful NIA check and clean evidence", async () => {
    const draft = await service.createDraft(applicant);
    const saved = await saveApplicant(draft);

    await expect(
      service.submit(draft.id, applicant, submitInput(saved.version)),
    ).rejects.toMatchObject({ code: "APPLICANT_IDENTITY_INCOMPLETE" });
    await seedVerifiedIdentity(applicant.personId);
    await expect(
      service.submit(draft.id, applicant, submitInput(saved.version)),
    ).rejects.toMatchObject({ code: "APPLICANT_DOCUMENTS_INCOMPLETE" });
  });

  it("does not submit until the guarantor completes independently", async () => {
    const draft = await service.createDraft(applicant);
    const saved = await completePersonAndApplicant(draft);
    const invitation = await service.inviteGuarantor(draft.id, applicant, {
      expectedVersion: saved.version,
      mutationId: randomUUID(),
      guarantorPhoneE164: guarantorPhone,
    });

    await expect(
      service.submit(
        draft.id,
        applicant,
        submitInput(invitation.applicationVersion),
      ),
    ).rejects.toMatchObject({ code: "GUARANTOR_INCOMPLETE" });
    await expect(
      service.getCompleteness(draft.id, guarantor),
    ).rejects.toMatchObject({ code: "APPLICATION_NOT_FOUND" });
  });

  it("requires the guarantor's own NIA check and clean evidence", async () => {
    const { draft, invitation } = await prepareInvitation();
    const guarantorSaved = await service.saveGuarantor(
      invitation.token,
      guarantor,
      guarantorSave(1),
    );

    await expect(
      service.submit(
        draft.id,
        applicant,
        submitInput(guarantorSaved.applicationVersion),
      ),
    ).rejects.toMatchObject({ code: "GUARANTOR_IDENTITY_INCOMPLETE" });
    await seedVerifiedIdentity(guarantor.personId);
    await expect(
      service.submit(
        draft.id,
        applicant,
        submitInput(guarantorSaved.applicationVersion),
      ),
    ).rejects.toMatchObject({ code: "GUARANTOR_DOCUMENTS_INCOMPLETE" });
  });

  it("atomically snapshots, transitions, audits, and enqueues a complete submission", async () => {
    const { draft, invitation } = await prepareInvitation();
    await seedVerifiedIdentity(guarantor.personId);
    await seedCleanDocument(guarantor.personId, "GHANA_CARD_FRONT");
    const guarantorSaved = await service.saveGuarantor(
      invitation.token,
      guarantor,
      guarantorSave(1),
    );

    const submitted = await service.submit(
      draft.id,
      applicant,
      submitInput(guarantorSaved.applicationVersion),
    );

    expect(submitted).toMatchObject({ status: "VERIFICATION_REVIEW" });
    const evidence = await readApplicationRow<{
      status: string;
      versions: number;
      audits: number;
      outbox: number;
      snapshot: Record<string, unknown>;
    }>(
      `select a.status,
              (select count(*)::int from application_version v where v.application_id = a.id) versions,
              (select count(*)::int from audit_event e where e.aggregate_id = a.id and e.action = 'APPLICATION_SUBMITTED') audits,
              (select count(*)::int from outbox_message o where o.aggregate_id = a.id and o.topic = 'applications.submitted') outbox,
              (select v.snapshot from application_version v where v.application_id = a.id) snapshot
         from application a where a.id = $1`,
      [draft.id],
    );
    expect(evidence).toMatchObject({
      status: "VERIFICATION_REVIEW",
      versions: 1,
      audits: 1,
      outbox: 1,
      snapshot: {
        applicationId: draft.id,
        applicantPersonId: applicant.personId,
        guarantorPersonId: guarantor.personId,
        vehicleModelId,
      },
    });
    expect(await attemptApplicationVersionMutation(draft.id)).toBe("55000");
  });
});

describe("customer application routes", () => {
  it("redacts invitation credentials from structured request logs", () => {
    expect(redactedLogPaths).toContain("body.invitationToken");
  });

  it("wires the customer application module into the composed API", async () => {
    const app = await buildApp({
      config: testConfig,
      database,
      logger: false,
      identity: {
        sms: {
          async send() {
            throw new Error("OUTBOX_ONLY");
          },
        },
        otpPolicy: {
          ttlMs: 120_000,
          attemptLimit: 3,
          resendCooldownMs: 30_000,
          codeLength: 6,
          hashSecret: "test-otp-hash-secret-with-at-least-32-characters",
          deliveryDerivationSecret:
            "test-delivery-secret-with-at-least-32-characters",
          deliveryDerivationKeyId: otpDerivationKeyId(
            "test-delivery-secret-with-at-least-32-characters",
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
      },
      applications: {
        invitationHashSecret:
          "test-invitation-secret-with-at-least-32-characters",
        invitationTtlMs: 30 * 60_000,
        requiredDocumentTypes: requiredDocuments,
      },
    });
    const response = await app.inject({
      method: "GET",
      url: "/v1/customer/vehicle-models",
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "AUTHENTICATION_FAILED" });
    await app.close();
  });

  it("authenticates catalogue and draft commands without disclosing them cross-customer", async () => {
    const app = fastify({ logger: false, genReqId: () => randomUUID() });
    await registerProblemErrors(app);
    await registerApplicationRoutes(
      app,
      {
        async authenticateSessionToken(token: string) {
          const actor = token === "a".repeat(43) ? applicant : other;
          return {
            kind: "customer" as const,
            customerAccountId: randomUUID(),
            personId: actor.personId,
            sessionId: actor.sessionId,
          };
        },
      },
      service,
    );

    const models = await app.inject({
      method: "GET",
      url: "/v1/customer/vehicle-models",
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toEqual([
      {
        id: vehicleModelId,
        manufacturer: "Synthetic Motors",
        modelName: "Pilot Bike",
        modelYear: 2026,
      },
    ]);

    const created = await app.inject({
      method: "POST",
      url: "/v1/customer/applications",
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    });
    expect(created.statusCode).toBe(201);
    const draft = created.json<{ id: string; version: number }>();
    const resumed = await app.inject({
      method: "GET",
      url: "/v1/customer/applications/resume",
      headers: { authorization: `Bearer ${"a".repeat(43)}` },
    });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json()).toMatchObject({
      draft: { id: draft.id, version: draft.version },
      guarantorStatus: "NOT_INVITED",
    });
    const hidden = await app.inject({
      method: "GET",
      url: `/v1/customer/applications/${draft.id}/completeness`,
      headers: { authorization: `Bearer ${"b".repeat(43)}` },
    });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toMatchObject({ code: "APPLICATION_NOT_FOUND" });
    await app.close();
  });
});

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
  bodyLimitBytes: 1_024 * 1_024,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};

async function prepareInvitation() {
  const draft = await service.createDraft(applicant);
  const saved = await completePersonAndApplicant(draft);
  const invitation = await service.inviteGuarantor(draft.id, applicant, {
    expectedVersion: saved.version,
    mutationId: randomUUID(),
    guarantorPhoneE164: guarantorPhone,
  });
  return { draft, invitation };
}

async function completePersonAndApplicant(draft: {
  id: string;
  version: number;
}) {
  await seedVerifiedIdentity(applicant.personId);
  await seedCleanDocument(applicant.personId, "GHANA_CARD_FRONT");
  return saveApplicant(draft);
}

function saveApplicant(draft: { id: string; version: number }) {
  return service.saveApplicant(draft.id, applicant, {
    expectedVersion: draft.version,
    mutationId: randomUUID(),
    vehicleModelId,
    profile: { occupation: "Courier", residentialArea: "Dansoman" },
  });
}

function guarantorSave(expectedVersion: number) {
  return {
    expectedVersion,
    mutationId: randomUUID(),
    profile: { occupation: "Mechanic", relationshipToApplicant: "Sibling" },
  };
}

function submitInput(expectedVersion: number) {
  return { expectedVersion, mutationId: randomUUID() };
}

function context(personId: string): ApplicationContext {
  return { personId, sessionId: randomUUID(), requestId: randomUUID() };
}

function mutableClock(iso: string) {
  let now = new Date(iso);
  return {
    now: () => new Date(now),
    advance: (milliseconds: number) => {
      now = new Date(now.getTime() + milliseconds);
    },
  };
}
