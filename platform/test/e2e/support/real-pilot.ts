import { createHash, randomUUID } from "node:crypto";
import argon2 from "../../../apps/api/node_modules/argon2/argon2.cjs";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type DatabaseStaffRole,
} from "../../../packages/db/src/index.js";
import {
  createNiaSimulator,
  createPaymentWebhookSimulator,
  createSmsSimulator,
  createTrackerSimulator,
} from "../../../packages/integrations/src/simulators/index.js";
import type { NiaSimulatorFixture } from "../../../packages/integrations/src/simulators/nia.js";
import type {
  CanonicalPaymentEvent,
  NiaPort,
  ObjectStoragePort,
  PaymentWebhookVerifier,
  SmsPort,
  TrackerPort,
} from "../../../packages/integrations/src/index.js";
import {
  FinanceApprovalGate,
  canonicalizeJson,
  hashWorkedExample,
  type WorkedExampleFixture,
} from "../../../packages/domain/src/index.js";
import { buildApp } from "../../../apps/api/src/app.js";
import type { AppConfig } from "../../../apps/api/src/config.js";
import {
  ALLOCATION_POLICY_BEHAVIOR_DIGEST,
  ALLOCATION_POLICY_EXECUTION_KEY,
  ALLOCATION_POLICY_VERSION,
  hashAllocationEvidenceArtifact,
  type AllocationPolicy,
} from "../../../apps/api/src/modules/payments/ledger-service.js";
import { createSyntheticContractTemplateForTesting } from "../../../apps/api/src/modules/contracts/service.js";
import {
  executeTestSql,
  readLatestOtpChallenge,
  resetTestDatabase,
  seedApplicationOnboardingFixtures,
} from "../../../packages/testkit/src/index.js";
import {
  deriveOtpCode,
  otpDerivationKeyId,
} from "../../../packages/integrations/src/index.js";

export const applicantPhone = "+233241000001";
export const guarantorPhone = "+233241000002";
export const testPassword = "correct horse battery staple";
export const testOtpSecret = "controlled-pilot-otp-delivery-secret-32-chars";
export const testOtpHashSecret = "controlled-pilot-otp-hash-secret-32-chars";

export type PilotRole =
  | "VERIFICATION_OFFICER"
  | "BSM"
  | "AGM"
  | "CFO"
  | "MD"
  | "PRODUCT_ADMIN"
  | "INVENTORY_OFFICER"
  | "FINANCE_OFFICER"
  | "RECOVERY_OFFICER"
  | "CUSTOMER_SUPPORT";

export interface StaffSession {
  readonly role: PilotRole;
  readonly staffUserId: string;
  readonly email: string;
  readonly cookie: string;
  readonly csrfToken: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface CustomerSession {
  readonly personId: string;
  readonly token: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface PilotRuntime {
  readonly baseUrl: string;
  readonly applicationFixtures: Awaited<
    ReturnType<typeof seedApplicationOnboardingFixtures>
  >;
  readonly productId: string;
  readonly databaseUrl: string;
  readonly staff: ReadonlyMap<PilotRole, StaffSession>;
  readonly customer: {
    applicant: CustomerSession;
    guarantor: CustomerSession;
  };
  readonly paymentPolicy: AllocationPolicy;
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  attachProduct(applicationId: string): Promise<void>;
  uploadDocument(
    ticket: {
      uploadUrl: string;
      requiredHeaders: Readonly<Record<string, string>>;
    },
    bytes: Uint8Array,
    contentType: string,
  ): void;
  addPaymentFixture(input: {
    rawBody: Uint8Array;
    signature: string;
    requestTimestamp: string;
    event: CanonicalPaymentEvent;
  }): void;
  close(): Promise<void>;
}

const configFor = (databaseUrl: string): AppConfig => ({
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl,
  allowedOrigins: ["http://127.0.0.1", "http://localhost"],
  cookieName: "somo_staff_session",
  cookieSecret: "controlled-pilot-cookie-secret-at-least-32-characters",
  auditTargetHmacSecret: "controlled-pilot-audit-secret-at-least-32-characters",
  cookieSecure: false,
  bodyLimitBytes: 1_048_576,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
  niaAdapter: "controlled-pilot-simulator",
  smsAdapter: "controlled-pilot-simulator",
  paymentAdapter: "controlled-pilot-simulator",
  objectStoragePublic: false,
  encryptionKeyRef: "secret/somo/test/document-encryption",
  backupLastVerifiedAt: "2026-08-22T00:00:00.000Z",
});

export async function startRealPilot(): Promise<PilotRuntime> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl !== "postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test") {
    throw new Error("CONTROLLED_PILOT_TEST_DATABASE_REQUIRED");
  }

  await resetTestDatabase(databaseUrl);
  const connection = createDatabase(databaseUrl);
  const database = connection.db;
  await migrateDatabase(database);
  const applicationFixtures = await seedApplicationOnboardingFixtures();
  const productId = randomUUID();
  await executeTestSql(
    databaseUrl,
    `insert into product (id, code, name, vehicle_model_id, status)
     values ($1, $2, 'Controlled pilot product', $3, 'ACTIVE')`,
    [
      productId,
      `CONTROLLED-PILOT-${productId.slice(0, 8)}`,
      applicationFixtures.vehicleModelId,
    ],
  );

  const fixture = financingFixture();
  const paymentPolicy = allocationPolicy();
  await persistAllocationPolicy(databaseUrl, paymentPolicy);
  const objectStorage = memoryObjectStorage();
  const nia: NiaPort = dynamicNiaSimulator();
  const sms: SmsPort = dynamicSmsSimulator();
  const paymentFixtures: Array<{
    rawBody: Uint8Array;
    signature: string;
    requestTimestamp: string;
    event: CanonicalPaymentEvent;
  }> = [];
  const paymentVerifier: PaymentWebhookVerifier = {
    async verify(input) {
      return createPaymentWebhookSimulator({
        environment: "test",
        fixtures: paymentFixtures,
      }).verify(input);
    },
  };
  const tracker: TrackerPort = createTrackerSimulator({
    environment: "test",
    fixtures: [
      {
        trackerId: "CONTROLLED-PILOT-TRACKER-001",
        result: {
          latitude: "5.603717",
          longitude: "-0.186964",
          recordedAt: "2026-08-01T12:00:00.000Z",
          deviceStatus: "ONLINE",
        },
      },
    ],
  });

  const app = await buildApp({
    config: configFor(databaseUrl),
    database,
    logger: false,
    mfaVerifier: {
      kind: "test",
      async verify() {
        return true;
      },
    },
    identity: {
      sms,
      nia,
      otpPolicy: {
        ttlMs: 120_000,
        attemptLimit: 3,
        resendCooldownMs: 1,
        codeLength: 6,
        hashSecret: testOtpHashSecret,
        deliveryDerivationSecret: testOtpSecret,
        deliveryDerivationKeyId: otpDerivationKeyId(testOtpSecret),
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
        storage: objectStorage,
        malwareScanner: {
          async scan() {
            return {
              verdict: "CLEAN" as const,
              scannerReference: "controlled-pilot-malware",
            };
          },
        },
        policy: {
          allowedMimeTypes: ["image/png"],
          maxBytes: 1024,
          uploadTtlMs: 60_000,
          downloadTtlMs: 30_000,
        },
      },
    },
    applications: {
      invitationHashSecret:
        "controlled-pilot-invitation-secret-at-least-32-chars",
      invitationTtlMs: 30 * 60_000,
      requiredDocumentTypes: ["GHANA_CARD_FRONT"],
    },
    financing: { fixtureGate: FinanceApprovalGate.forTesting([fixture]) },
    tracker,
    contracts: {
      template: createSyntheticContractTemplateForTesting(),
      headOffice: { id: "CONTROLLED-PILOT-HEAD-OFFICE", location: "Accra" },
    },
    payments: {
      verifier: paymentVerifier,
      allocationPolicy: paymentPolicy,
      sms,
      accountLinkBaseUrl: "https://customer.test.somo.example/account",
      ussdInstructions: "Dial *123# and select Somoco Payments.",
    },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === "string")
    throw new Error("PILOT_API_ADDRESS_UNAVAILABLE");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const staff = new Map<PilotRole, StaffSession>();
  for (const role of [
    "VERIFICATION_OFFICER",
    "BSM",
    "AGM",
    "CFO",
    "MD",
    "PRODUCT_ADMIN",
    "INVENTORY_OFFICER",
    "FINANCE_OFFICER",
    "RECOVERY_OFFICER",
    "CUSTOMER_SUPPORT",
  ] as const) {
    const email = `controlled-pilot-${role.toLowerCase()}@example.test`;
    staff.set(
      role,
      await createStaffSession(app, database, role, email, databaseUrl),
    );
  }

  const productChecker = await createStaffSession(
    app,
    database,
    "PRODUCT_ADMIN",
    "controlled-pilot-product-checker@example.test",
    databaseUrl,
  );
  await createAndPublishProductRule(
    app,
    baseUrl,
    staff.get("PRODUCT_ADMIN")!,
    productChecker,
    productId,
    fixture,
  );
  const customerCsrf = staff.get("CUSTOMER_SUPPORT")!;
  const applicant = await authenticateCustomer(
    app,
    databaseUrl,
    applicationFixtures.applicantId,
    applicantPhone,
    customerCsrf.headers,
  );
  const guarantor = await authenticateCustomer(
    app,
    databaseUrl,
    applicationFixtures.guarantorId,
    guarantorPhone,
    customerCsrf.headers,
  );
  return {
    baseUrl,
    applicationFixtures,
    productId,
    databaseUrl,
    staff,
    customer: { applicant, guarantor },
    paymentPolicy,
    app,
    async attachProduct(applicationId: string) {
      // Setup-only linkage: the public customer application-create route does
      // not accept a product and no product-assignment route exists. The
      // customer/staff workflow remains public from this point onward.
      await executeTestSql(
        databaseUrl,
        "update application set product_id = $2 where id = $1",
        [applicationId, productId],
      );
    },
    uploadDocument(ticket, bytes, contentType) {
      objectStorage.upload(ticket, bytes, contentType);
    },
    addPaymentFixture(input) {
      paymentFixtures.push(input);
    },
    async close() {
      await app.close();
      await connection.close();
    },
  };
}

async function authenticateCustomer(
  app: Awaited<ReturnType<typeof buildApp>>,
  databaseUrl: string,
  personId: string,
  phoneE164: string,
  csrfHeaders: Readonly<Record<string, string>>,
): Promise<CustomerSession> {
  const request = await app.inject({
    method: "POST",
    url: "/v1/customer/otp/requests",
    payload: { phoneE164 },
  });
  if (request.statusCode !== 202)
    throw new Error(`CUSTOMER_OTP_REQUEST_FAILED_${request.statusCode}`);
  const challenge = await readLatestOtpChallenge(databaseUrl, personId);
  if (challenge === null) throw new Error("CUSTOMER_OTP_CHALLENGE_MISSING");
  const code = deriveOtpCode(testOtpSecret, challenge.id, 6);
  const verified = await app.inject({
    method: "POST",
    url: "/v1/customer/otp/verifications",
    payload: { phoneE164, code },
  });
  if (verified.statusCode !== 201)
    throw new Error(`CUSTOMER_OTP_VERIFY_FAILED_${verified.statusCode}`);
  const token = verified.json<{ sessionToken: string }>().sessionToken;
  return {
    personId,
    token,
    headers: {
      authorization: `Bearer ${token}`,
      cookie: csrfHeaders.cookie!,
      "x-csrf-token": csrfHeaders["x-csrf-token"]!,
    },
  };
}

async function createStaffSession(
  app: Awaited<ReturnType<typeof buildApp>>,
  database: ReturnType<typeof createDatabase>["db"],
  role: PilotRole,
  email: string,
  databaseUrl: string,
): Promise<StaffSession> {
  const passwordHash = await argon2.hash(testPassword, {
    type: argon2.argon2id,
    memoryCost: configFor(databaseUrl).argon2MemoryCostKiB,
    timeCost: configFor(databaseUrl).argon2TimeCost,
    parallelism: configFor(databaseUrl).argon2Parallelism,
  });
  const user = await createStaffUser(database, {
    email,
    passwordHash,
    roles: [role as DatabaseStaffRole],
  });
  const response = await app.inject({
    method: "POST",
    url: "/v1/staff/sessions",
    remoteAddress: "127.0.0.1",
    payload: {
      email,
      password: testPassword,
      mfaAssertion: "controlled-pilot",
    },
  });
  if (response.statusCode !== 201)
    throw new Error(`STAFF_LOGIN_FAILED_${role}_${response.statusCode}`);
  const cookie = cookieHeader(response.headers["set-cookie"]);
  const csrfToken = response.json<{ csrfToken: string }>().csrfToken;
  return {
    role,
    staffUserId: user.id,
    email,
    cookie,
    csrfToken,
    headers: { cookie, "x-csrf-token": csrfToken },
  };
}

async function createAndPublishProductRule(
  app: Awaited<ReturnType<typeof buildApp>>,
  baseUrl: string,
  maker: StaffSession,
  checker: StaffSession,
  productId: string,
  fixture: WorkedExampleFixture,
): Promise<void> {
  const disclosureContent = {
    version: "controlled-pilot-disclosure-v1",
    body: "Synthetic test disclosure",
  };
  const disclosureHash = createHash("sha256")
    .update(
      canonicalizeJson({
        version: "controlled-pilot-disclosure-v1",
        content: disclosureContent,
      }),
    )
    .digest("hex");
  const draft = await app.inject({
    method: "POST",
    url: `/v1/staff/products/${productId}/rule-versions`,
    headers: maker.headers,
    payload: {
      versionNumber: 1,
      sellingPriceMinor: "100000",
      minimumDepositMinor: "10000",
      method: "FLAT_MARKUP",
      rateBasisPoints: 0,
      allowedTenuresMonths: [6],
      repaymentFrequencies: ["MONTHLY"],
      permittedFees: {},
      disclosureVersion: "controlled-pilot-disclosure-v1",
      disclosureContent,
      disclosureHash,
      fixtureHashes: [fixture.canonicalHash],
      licencePermitted: true,
    },
  });
  if (draft.statusCode !== 201)
    throw new Error(
      `PRODUCT_RULE_CREATE_FAILED_${draft.statusCode}_${draft.body}`,
    );
  const ruleId = draft.json<{ id: string }>().id;
  const published = await app.inject({
    method: "POST",
    url: `/v1/staff/products/rule-versions/${ruleId}/publish`,
    headers: checker.headers,
    payload: {
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      idempotencyKey: randomUUID(),
    },
  });
  if (published.statusCode !== 200)
    throw new Error(
      `PRODUCT_RULE_PUBLISH_FAILED_${published.statusCode}_${published.body}`,
    );
  void baseUrl;
}

function financingFixture(): WorkedExampleFixture {
  const unsigned = {
    schemaVersion: 1 as const,
    fixtureId: "controlled-pilot-monthly-6",
    method: "FLAT_MARKUP" as const,
    frequency: "MONTHLY" as const,
    tenureMonths: 6 as const,
    workedExample: { testOnly: true },
    financeApproved: true,
    complianceApproved: true,
    licencePermitted: true,
    synthetic: true,
  };
  return { ...unsigned, canonicalHash: hashWorkedExample(unsigned) };
}

function allocationPolicy(): AllocationPolicy {
  const artifact = Object.freeze({
    externalArtifactId: "controlled-pilot-policy-v1",
    artifactRevision: 1,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
  });
  return Object.freeze({
    version: ALLOCATION_POLICY_VERSION,
    executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
    behaviorDigest: ALLOCATION_POLICY_BEHAVIOR_DIGEST,
    evidence: Object.freeze({
      artifact,
      evidenceHash: hashAllocationEvidenceArtifact(artifact),
      financeApprovedBy: "controlled-pilot-finance",
      complianceApprovedBy: "controlled-pilot-compliance",
      financeSignature: "controlled-pilot-finance-signature",
      complianceSignature: "controlled-pilot-compliance-signature",
      financeApprovedAt: "2026-08-01T00:00:00.000Z",
      complianceApprovedAt: "2026-08-01T01:00:00.000Z",
    }),
  });
}

async function persistAllocationPolicy(
  databaseUrl: string,
  policy: AllocationPolicy,
): Promise<void> {
  const e = policy.evidence;
  await executeTestSql(
    databaseUrl,
    `insert into payment_allocation_policy
    (version, policy_hash, worked_example_hash, worked_example, behavior_digest, evidence_hash, evidence_artifact,
     finance_approved_by, compliance_approved_by, finance_signature, compliance_signature,
     finance_approved_at, compliance_approved_at, approved_at, status)
    values ($1, $2, $2, $3::jsonb, $4, $2, $3::jsonb, $5, $6, $7, $8, $9, $10, $9, 'APPROVED')`,
    [
      policy.version,
      e.evidenceHash,
      JSON.stringify(e.artifact),
      policy.behaviorDigest,
      e.financeApprovedBy,
      e.complianceApprovedBy,
      e.financeSignature,
      e.complianceSignature,
      e.financeApprovedAt,
      e.complianceApprovedAt,
    ],
  );
}

function dynamicNiaSimulator(): NiaPort {
  return {
    async verify(input) {
      const fixture: NiaSimulatorFixture = {
        input,
        result: {
          providerReference: `controlled-pilot-nia-${input.correlationId}`,
          decision: "MATCH",
          checkedAt: "2026-08-01T12:00:00.000Z",
        },
      };
      return createNiaSimulator({
        environment: "test",
        fixtures: [fixture],
      }).verify(input);
    },
  };
}

function dynamicSmsSimulator(): SmsPort {
  return {
    async send(input) {
      return createSmsSimulator({
        environment: "test",
        fixtures: [
          {
            input,
            result: {
              providerReference: `controlled-pilot-sms-${input.idempotencyKey}`,
              acceptedAt: "2026-08-01T12:00:00.000Z",
            },
          },
        ],
      }).send(input);
    },
  };
}

function cookieHeader(value: unknown): string {
  const values = Array.isArray(value) ? value : [value];
  const cookies = values
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.split(";", 1)[0]!);
  if (cookies.length === 0) throw new Error("STAFF_COOKIE_MISSING");
  return cookies.join("; ");
}

function memoryObjectStorage(): ObjectStoragePort & {
  upload(
    ticket: {
      uploadUrl: string;
      requiredHeaders: Readonly<Record<string, string>>;
    },
    bytes: Uint8Array,
    contentType: string,
  ): void;
} {
  type Stored = {
    bytes: Uint8Array;
    contentType: string;
    metadata: Readonly<Record<string, string>>;
    versionId: string;
    etag: string;
  };
  const objects = new Map<string, Stored>();
  return {
    async createUploadTicket(input) {
      return {
        uploadUrl: `memory://upload/${input.objectKey}`,
        requiredHeaders: input.requiredHeaders,
      };
    },
    async readObject(input) {
      const object = objects.get(input.objectKey);
      if (object === undefined) throw new Error("OBJECT_NOT_FOUND");
      if (object.bytes.byteLength > input.maxBytes)
        throw new Error("OBJECT_TOO_LARGE");
      return { ...object, contentLength: object.bytes.byteLength };
    },
    async promoteToImmutable(input) {
      const source = objects.get(input.stagingObjectKey);
      if (
        source === undefined ||
        source.versionId !== input.stagingVersionId ||
        source.etag !== input.stagingEtag
      )
        throw new Error("STAGING_IDENTITY_MISMATCH");
      const promoted = {
        ...source,
        bytes: Uint8Array.from(source.bytes),
        versionId: randomUUID(),
      };
      objects.set(input.immutableObjectKey, promoted);
      return {
        objectKey: input.immutableObjectKey,
        versionId: promoted.versionId,
        etag: promoted.etag,
      };
    },
    async createDownloadTicket(input) {
      return {
        downloadUrl: `memory://download/${input.objectKey}`,
        expiresAt: input.expiresAt.toISOString(),
        requiredHeaders: { "if-match": input.etag },
      };
    },
    upload(ticket, bytes, contentType) {
      const objectKey = ticket.uploadUrl.replace("memory://upload/", "");
      const metadata = Object.fromEntries(
        Object.entries(ticket.requiredHeaders)
          .filter(([key]) => key.startsWith("x-amz-meta-"))
          .map(([key, value]) => [key.slice("x-amz-meta-".length), value]),
      );
      objects.set(objectKey, {
        bytes: Uint8Array.from(bytes),
        contentType,
        metadata,
        versionId: randomUUID(),
        etag: createHash("sha256").update(bytes).digest("hex"),
      });
    },
  };
}
