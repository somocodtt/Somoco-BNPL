import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { customerAccount, customerSession } from "../schema/access.js";
import {
  consentEvidence,
  identityCheck,
  otpChallenge,
  person,
} from "../schema/privacy.js";
import {
  getInternalExecutor,
  getInternalTransaction,
  type DatabaseTransaction,
} from "../transaction.js";

export async function findPersonByPhone(
  db: Database | DatabaseTransaction,
  phoneE164: string,
) {
  const [record] = await getInternalExecutor(db)
    .select({ id: person.id, phoneE164: person.phoneE164 })
    .from(person)
    .where(eq(person.phoneE164, phoneE164))
    .limit(1);
  return record ?? null;
}

export async function findPersonById(
  db: Database | DatabaseTransaction,
  personId: string,
) {
  const [record] = await getInternalExecutor(db)
    .select({ id: person.id, phoneE164: person.phoneE164 })
    .from(person)
    .where(eq(person.id, personId))
    .limit(1);
  return record ?? null;
}

export async function createConsentEvidence(
  tx: DatabaseTransaction,
  input: {
    id: string;
    personId: string;
    purpose: string;
    documentVersion: string;
    evidence: Readonly<Record<string, unknown>>;
    acceptedAt: Date;
  },
) {
  const [created] = await getInternalTransaction(tx)
    .insert(consentEvidence)
    .values({
      id: input.id,
      personId: input.personId,
      purpose: input.purpose,
      policyVersion: input.documentVersion,
      evidence: input.evidence,
      consentedAt: input.acceptedAt,
    })
    .returning();
  if (created === undefined) throw new Error("CONSENT_EVIDENCE_CREATE_FAILED");
  return created;
}

export async function findOwnedConsentEvidence(
  db: Database | DatabaseTransaction,
  input: { consentId: string; personId: string; purpose: string },
) {
  const [record] = await getInternalExecutor(db)
    .select({
      id: consentEvidence.id,
      personId: consentEvidence.personId,
      purpose: consentEvidence.purpose,
      documentVersion: consentEvidence.policyVersion,
      acceptedAt: consentEvidence.consentedAt,
      withdrawnAt: consentEvidence.withdrawnAt,
    })
    .from(consentEvidence)
    .where(
      and(
        eq(consentEvidence.id, input.consentId),
        eq(consentEvidence.personId, input.personId),
        eq(consentEvidence.purpose, input.purpose),
      ),
    )
    .limit(1);
  return record ?? null;
}

export async function reserveIdentityCheck(
  tx: DatabaseTransaction,
  input: {
    id: string;
    personId: string;
    provider: string;
    idempotencyKey: string;
    providerCorrelationId: string;
    consentEvidenceId: string;
    evidence: Readonly<Record<string, unknown>>;
    createdAt: Date;
  },
) {
  const [created] = await getInternalTransaction(tx)
    .insert(identityCheck)
    .values({
      ...input,
      providerReference: null,
      status: "PENDING",
      checkedAt: null,
    })
    .onConflictDoNothing({
      target: [identityCheck.provider, identityCheck.idempotencyKey],
    })
    .returning(identityCheckProjection);
  if (created !== undefined)
    return { record: created, reserved: true as const };
  const existing = await findIdentityCheckByIdempotencyKey(tx, {
    provider: input.provider,
    idempotencyKey: input.idempotencyKey,
  });
  if (existing === null) throw new Error("IDENTITY_CHECK_RESERVE_FAILED");
  return { record: existing, reserved: false as const };
}

export async function findIdentityCheckByIdempotencyKey(
  db: Database | DatabaseTransaction,
  input: { provider: string; idempotencyKey: string },
) {
  const [record] = await getInternalExecutor(db)
    .select(identityCheckProjection)
    .from(identityCheck)
    .where(
      and(
        eq(identityCheck.provider, input.provider),
        eq(identityCheck.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);
  return record ?? null;
}

export async function findIdentityCheckByProviderReference(
  db: Database | DatabaseTransaction,
  input: { provider: string; providerReference: string },
) {
  const [record] = await getInternalExecutor(db)
    .select(identityCheckProjection)
    .from(identityCheck)
    .where(
      and(
        eq(identityCheck.provider, input.provider),
        eq(identityCheck.providerReference, input.providerReference),
      ),
    )
    .limit(1);
  return record ?? null;
}

export async function findIdentityCheckById(
  db: Database | DatabaseTransaction,
  identityCheckId: string,
) {
  const [record] = await getInternalExecutor(db)
    .select(identityCheckProjection)
    .from(identityCheck)
    .where(eq(identityCheck.id, identityCheckId))
    .limit(1);
  return record ?? null;
}

export async function claimIdentityCheck(
  db: Database | DatabaseTransaction,
  input: {
    identityCheckId: string;
    processingToken: string;
    leaseMs: number;
  },
) {
  const [record] = await getInternalExecutor(db)
    .update(identityCheck)
    .set({
      processingToken: input.processingToken,
      processingStartedAt: sql`clock_timestamp()`,
    })
    .where(
      and(
        eq(identityCheck.id, input.identityCheckId),
        eq(identityCheck.status, "PENDING"),
        sql`(
          ${identityCheck.processingToken} is null
          or ${identityCheck.processingStartedAt} <
            clock_timestamp() - (${input.leaseMs} * interval '1 millisecond')
        )`,
      ),
    )
    .returning(identityCheckProjection);
  return record ?? null;
}

export async function lockIdentityProviderReference(
  tx: DatabaseTransaction,
  input: { provider: string; providerReference: string },
): Promise<void> {
  await getInternalTransaction(tx).execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(
        concat(${input.provider}::text, ':', ${input.providerReference}::text),
        0
      )
    )
  `);
}

export async function releaseIdentityCheckClaim(
  db: Database | DatabaseTransaction,
  input: { identityCheckId: string; processingToken: string },
): Promise<void> {
  await getInternalExecutor(db)
    .update(identityCheck)
    .set({ processingToken: null, processingStartedAt: null })
    .where(
      and(
        eq(identityCheck.id, input.identityCheckId),
        eq(identityCheck.processingToken, input.processingToken),
        eq(identityCheck.status, "PENDING"),
      ),
    );
}

export async function completeIdentityCheck(
  tx: DatabaseTransaction,
  input: {
    identityCheckId: string;
    processingToken: string;
    providerReference: string;
    status: "VERIFIED" | "FAILED" | "MANUAL_REVIEW";
    evidence: Readonly<Record<string, unknown>>;
    checkedAt: Date;
  },
) {
  const [record] = await getInternalTransaction(tx)
    .update(identityCheck)
    .set({
      providerReference: input.providerReference,
      status: input.status,
      evidence: input.evidence,
      checkedAt: input.checkedAt,
      processingToken: null,
      processingStartedAt: null,
    })
    .where(
      and(
        eq(identityCheck.id, input.identityCheckId),
        eq(identityCheck.processingToken, input.processingToken),
        eq(identityCheck.status, "PENDING"),
      ),
    )
    .returning(identityCheckProjection);
  if (record === undefined) throw new Error("IDENTITY_CHECK_COMPLETE_FAILED");
  return record;
}

export async function markDuplicateIdentityCheck(
  tx: DatabaseTransaction,
  input: {
    identityCheckId: string;
    processingToken: string;
    duplicateOfIdentityCheckId: string;
    consentEvidenceId: string;
    requestFingerprint: string;
    checkedAt: Date;
  },
): Promise<void> {
  await getInternalTransaction(tx)
    .update(identityCheck)
    .set({
      status: "FAILED",
      evidence: {
        reason: "PROVIDER_REFERENCE_DUPLICATE",
        duplicateOfIdentityCheckId: input.duplicateOfIdentityCheckId,
        consentEvidenceId: input.consentEvidenceId,
        requestFingerprint: input.requestFingerprint,
      },
      checkedAt: input.checkedAt,
      processingToken: null,
      processingStartedAt: null,
    })
    .where(
      and(
        eq(identityCheck.id, input.identityCheckId),
        eq(identityCheck.processingToken, input.processingToken),
      ),
    );
}

export async function markIdentityCheckProviderReferenceConflict(
  tx: DatabaseTransaction,
  input: {
    identityCheckId: string;
    processingToken: string;
    consentEvidenceId: string;
    requestFingerprint: string;
    checkedAt: Date;
  },
): Promise<void> {
  await getInternalTransaction(tx)
    .update(identityCheck)
    .set({
      status: "FAILED",
      evidence: {
        reason: "PROVIDER_REFERENCE_CONFLICT",
        consentEvidenceId: input.consentEvidenceId,
        requestFingerprint: input.requestFingerprint,
      },
      checkedAt: input.checkedAt,
      processingToken: null,
      processingStartedAt: null,
    })
    .where(
      and(
        eq(identityCheck.id, input.identityCheckId),
        eq(identityCheck.processingToken, input.processingToken),
      ),
    );
}

const identityCheckProjection = {
  id: identityCheck.id,
  personId: identityCheck.personId,
  provider: identityCheck.provider,
  idempotencyKey: identityCheck.idempotencyKey,
  providerCorrelationId: identityCheck.providerCorrelationId,
  providerReference: identityCheck.providerReference,
  consentEvidenceId: identityCheck.consentEvidenceId,
  status: identityCheck.status,
  evidence: identityCheck.evidence,
  checkedAt: identityCheck.checkedAt,
  processingToken: identityCheck.processingToken,
  processingStartedAt: identityCheck.processingStartedAt,
  createdAt: identityCheck.createdAt,
} as const;

export async function lockPersonByPhone(
  tx: DatabaseTransaction,
  phoneE164: string,
) {
  const [record] = await getInternalTransaction(tx)
    .select({ id: person.id, phoneE164: person.phoneE164 })
    .from(person)
    .where(eq(person.phoneE164, phoneE164))
    .limit(1)
    .for("update");
  return record ?? null;
}

export async function lockOtpPhone(
  tx: DatabaseTransaction,
  keyedPhoneFingerprint: string,
): Promise<void> {
  await getInternalTransaction(tx).execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(${keyedPhoneFingerprint}::text, 0)
    )
  `);
}

export async function findLatestUsableOtpChallenge(
  tx: DatabaseTransaction,
  input: { personId: string; now: Date },
) {
  const [record] = await getInternalTransaction(tx)
    .select()
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.personId, input.personId),
        isNull(otpChallenge.invalidatedAt),
        gt(otpChallenge.expiresAt, input.now),
      ),
    )
    .orderBy(desc(otpChallenge.createdAt))
    .limit(1)
    .for("update");
  return record ?? null;
}

export async function findLatestOtpChallengeForCooldown(
  tx: DatabaseTransaction,
  personId: string,
) {
  const [record] = await getInternalTransaction(tx)
    .select()
    .from(otpChallenge)
    .where(
      and(
        eq(otpChallenge.personId, personId),
        isNull(otpChallenge.deliveryFailedAt),
      ),
    )
    .orderBy(desc(otpChallenge.createdAt))
    .limit(1)
    .for("update");
  return record ?? null;
}

export async function createOtpChallenge(
  tx: DatabaseTransaction,
  input: {
    id: string;
    personId: string;
    codeHash: string;
    expiresAt: Date;
    createdAt: Date;
  },
) {
  const [created] = await getInternalTransaction(tx)
    .insert(otpChallenge)
    .values(input)
    .returning();
  if (created === undefined) throw new Error("OTP_CHALLENGE_CREATE_FAILED");
  return created;
}

export async function createOtpChallengeIfPersonExists(
  tx: DatabaseTransaction,
  input: {
    id: string;
    personId: string;
    codeHash: string;
    expiresAt: Date;
    createdAt: Date;
  },
): Promise<boolean> {
  const result = await getInternalTransaction(tx).execute(sql`
    insert into privacy.otp_challenge
      (id, person_id, code_hash, expires_at, created_at)
    select ${input.id}::uuid, p.id, ${input.codeHash}, ${input.expiresAt}, ${input.createdAt}
      from privacy.person p
     where p.id = ${input.personId}::uuid
    returning id
  `);
  return result.rowCount === 1;
}

export async function findOtpDeliveryContext(
  db: Database | DatabaseTransaction,
  challengeId: string,
) {
  const [record] = await getInternalExecutor(db)
    .select({
      challengeId: otpChallenge.id,
      phoneE164: person.phoneE164,
      expiresAt: otpChallenge.expiresAt,
      invalidatedAt: otpChallenge.invalidatedAt,
      deliveryFailedAt: otpChallenge.deliveryFailedAt,
    })
    .from(otpChallenge)
    .innerJoin(person, eq(person.id, otpChallenge.personId))
    .where(eq(otpChallenge.id, challengeId))
    .limit(1);
  return record ?? null;
}

export async function recordFailedOtpAttempt(
  tx: DatabaseTransaction,
  input: {
    challengeId: string;
    attempts: number;
    invalidatedAt?: Date;
  },
): Promise<void> {
  await getInternalTransaction(tx)
    .update(otpChallenge)
    .set({
      attempts: input.attempts,
      ...(input.invalidatedAt === undefined
        ? {}
        : { invalidatedAt: input.invalidatedAt }),
    })
    .where(eq(otpChallenge.id, input.challengeId));
}

export async function invalidateOtpChallenge(
  tx: DatabaseTransaction,
  challengeId: string,
  invalidatedAt: Date,
): Promise<void> {
  await getInternalTransaction(tx)
    .update(otpChallenge)
    .set({ invalidatedAt })
    .where(
      and(eq(otpChallenge.id, challengeId), isNull(otpChallenge.invalidatedAt)),
    );
}

export async function markOtpDeliveryFailed(
  tx: DatabaseTransaction,
  challengeId: string,
  failedAt: Date,
): Promise<void> {
  await getInternalTransaction(tx)
    .update(otpChallenge)
    .set({ deliveryFailedAt: failedAt, invalidatedAt: failedAt })
    .where(eq(otpChallenge.id, challengeId));
}

export async function invalidateOutstandingOtpChallenges(
  tx: DatabaseTransaction,
  personId: string,
  invalidatedAt: Date,
): Promise<void> {
  await getInternalTransaction(tx)
    .update(otpChallenge)
    .set({ invalidatedAt })
    .where(
      and(
        eq(otpChallenge.personId, personId),
        isNull(otpChallenge.invalidatedAt),
      ),
    );
}

export async function findOrCreateCustomerAccount(
  tx: DatabaseTransaction,
  personId: string,
) {
  const executor = getInternalTransaction(tx);
  const [existing] = await executor
    .select()
    .from(customerAccount)
    .where(eq(customerAccount.personId, personId))
    .limit(1);
  if (existing !== undefined) return existing;
  const [created] = await executor
    .insert(customerAccount)
    .values({ personId })
    .returning();
  if (created === undefined) throw new Error("CUSTOMER_ACCOUNT_CREATE_FAILED");
  return created;
}

export async function createCustomerSession(
  tx: DatabaseTransaction,
  input: {
    customerAccountId: string;
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  },
) {
  const [created] = await getInternalTransaction(tx)
    .insert(customerSession)
    .values(input)
    .returning();
  if (created === undefined) throw new Error("CUSTOMER_SESSION_CREATE_FAILED");
  return created;
}

export async function findActiveCustomerSessionByTokenHash(
  db: Database,
  tokenHash: string,
  now: Date,
) {
  const [record] = await getInternalExecutor(db)
    .select({
      id: customerSession.id,
      customerAccountId: customerSession.customerAccountId,
      personId: customerAccount.personId,
      expiresAt: customerSession.expiresAt,
    })
    .from(customerSession)
    .innerJoin(
      customerAccount,
      eq(customerAccount.id, customerSession.customerAccountId),
    )
    .where(
      and(
        eq(customerSession.tokenHash, tokenHash),
        isNull(customerSession.revokedAt),
        gt(customerSession.expiresAt, now),
        eq(customerAccount.status, "ACTIVE"),
      ),
    )
    .limit(1);
  return record ?? null;
}
