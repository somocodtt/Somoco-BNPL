import { and, desc, eq, gt, isNull } from "drizzle-orm";
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

export async function createIdentityCheck(
  tx: DatabaseTransaction,
  input: {
    id: string;
    personId: string;
    provider: string;
    providerReference: string;
    status: "PENDING" | "VERIFIED" | "FAILED" | "MANUAL_REVIEW";
    evidence: Readonly<Record<string, unknown>>;
    checkedAt: Date;
    createdAt: Date;
  },
) {
  const [created] = await getInternalTransaction(tx)
    .insert(identityCheck)
    .values(input)
    .returning();
  if (created === undefined) throw new Error("IDENTITY_CHECK_CREATE_FAILED");
  return created;
}

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
