import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  appendAuditEvent,
  createCustomerSession,
  createOtpChallengeIfPersonExists,
  enqueueOutbox,
  findActiveCustomerSessionByTokenHash,
  findLatestUsableOtpChallenge,
  findLatestOtpChallengeForCooldown,
  findOrCreateCustomerAccount,
  invalidateOutstandingOtpChallenges,
  lockPersonByPhone,
  recordFailedOtpAttempt,
  withTransaction,
  type Database,
} from "@somo/db";
import { deriveOtpCode, type SmsPort } from "@somo/integrations";
import type { CustomerPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface OtpPolicy {
  ttlMs: number;
  attemptLimit: number;
  resendCooldownMs: number;
  codeLength: number;
  hashSecret: string;
  deliveryDerivationSecret: string;
  sessionTtlMs: number;
}

export interface Clock {
  now(): Date;
}

export type OtpWorkStep =
  | "person-lock"
  | "cooldown-read"
  | "otp-hash"
  | "challenge-invalidate"
  | "challenge-write"
  | "audit-write"
  | "outbox-write"
  | "challenge-read"
  | "otp-hash-compare"
  | "attempt-write";

export interface OtpService {
  request(input: {
    phoneE164: string;
    requestId: string;
  }): Promise<{ accepted: true }>;
  verify(input: {
    phoneE164: string;
    code: string;
    requestId: string;
  }): Promise<{
    verified: true;
    personId: string;
    customerAccountId: string;
    sessionId: string;
    sessionToken: string;
    expiresAt: string;
  }>;
  authenticateSessionToken(token: string): Promise<CustomerPrincipal>;
}

const acceptedResponse = Object.freeze({ accepted: true as const });

export function createOtpService(options: {
  database: Database;
  sms: SmsPort;
  policy: OtpPolicy;
  clock?: Clock;
  workObserver?: (step: OtpWorkStep) => void;
}): OtpService {
  const policy = validateOtpPolicy(options.policy);
  const clock = options.clock ?? { now: () => new Date() };

  return {
    async request(input) {
      const phoneE164 = normalizePhone(input.phoneE164);
      const now = clock.now();
      const challengeId = randomUUID();
      const code = deriveOtpCode(
        policy.deliveryDerivationSecret,
        challengeId,
        policy.codeLength,
      );
      await withTransaction(options.database, async (tx) => {
        const person = await lockPersonByPhone(tx, phoneE164);
        observe(options, "person-lock");
        const subjectId = person?.id ?? absentSubjectId;
        const latest = await findLatestOtpChallengeForCooldown(tx, subjectId);
        observe(options, "cooldown-read");
        const mayIssue =
          person !== null &&
          (latest === null ||
            now.getTime() - latest.createdAt.getTime() >=
              policy.resendCooldownMs);
        const persistedSubjectId = mayIssue ? subjectId : absentSubjectId;
        const codeHash = hashOtp(
          policy.hashSecret,
          challengeId,
          persistedSubjectId,
          code,
        );
        observe(options, "otp-hash");
        await invalidateOutstandingOtpChallenges(tx, persistedSubjectId, now);
        observe(options, "challenge-invalidate");
        await createOtpChallengeIfPersonExists(tx, {
          id: challengeId,
          personId: persistedSubjectId,
          codeHash,
          expiresAt: new Date(now.getTime() + policy.ttlMs),
          createdAt: now,
        });
        observe(options, "challenge-write");
        await appendAuditEvent(tx, {
          aggregateType: "otp_challenge",
          aggregateId: challengeId,
          action: "OTP_REQUESTED",
          requestId: input.requestId,
          data: { purpose: "CUSTOMER_AUTHENTICATION" },
          occurredAt: now,
        });
        observe(options, "audit-write");
        await enqueueOutbox(tx, {
          id: challengeId,
          topic: "identity.otp_sms_requested",
          aggregateType: "otp_challenge",
          aggregateId: challengeId,
          payload: {
            requestId: input.requestId,
            challengeId,
          },
          occurredAt: now,
        });
        observe(options, "outbox-write");
      });
      return acceptedResponse;
    },

    async verify(input) {
      const phoneE164 = normalizePhone(input.phoneE164);
      const now = clock.now();
      const sessionToken = randomBytes(32).toString("base64url");
      const outcome = await withTransaction(options.database, async (tx) => {
        const person = await lockPersonByPhone(tx, phoneE164);
        observe(options, "person-lock");
        const subjectId = person?.id ?? absentSubjectId;
        const challenge = await findLatestUsableOtpChallenge(tx, {
          personId: subjectId,
          now,
        });
        observe(options, "challenge-read");
        const challengeId = challenge?.id ?? absentChallengeId;
        const dummyExpected = hashOtp(
          policy.hashSecret,
          absentChallengeId,
          subjectId,
          "0".repeat(policy.codeLength),
        );
        const suppliedHash = hashOtp(
          policy.hashSecret,
          challengeId,
          subjectId,
          input.code,
        );
        const matches = equalHashes(
          challenge?.codeHash ?? dummyExpected,
          suppliedHash,
        );
        observe(options, "otp-hash-compare");
        if (
          person === null ||
          challenge === null ||
          challenge.attempts >= policy.attemptLimit ||
          !matches
        ) {
          const attempts = challenge === null ? 0 : challenge.attempts + 1;
          await recordFailedOtpAttempt(tx, {
            challengeId,
            attempts,
            ...(challenge !== null && attempts >= policy.attemptLimit
              ? { invalidatedAt: now }
              : {}),
          });
          observe(options, "attempt-write");
          await appendAuditEvent(tx, {
            aggregateType: "otp_challenge",
            aggregateId: challengeId,
            action: "OTP_VERIFICATION_REJECTED",
            requestId: input.requestId,
            data: { reason: "INVALID_OR_EXPIRED" },
            occurredAt: now,
          });
          observe(options, "audit-write");
          return null;
        }

        await invalidateOutstandingOtpChallenges(tx, person.id, now);
        const account = await findOrCreateCustomerAccount(tx, person.id);
        const expiresAt = new Date(now.getTime() + policy.sessionTtlMs);
        const session = await createCustomerSession(tx, {
          customerAccountId: account.id,
          tokenHash: hashSessionToken(sessionToken),
          expiresAt,
          createdAt: now,
        });
        await appendAuditEvent(tx, {
          aggregateType: "person",
          aggregateId: person.id,
          action: "OTP_VERIFIED",
          requestId: input.requestId,
          data: {
            purpose: "CUSTOMER_AUTHENTICATION",
            customerSessionId: session.id,
          },
          occurredAt: now,
        });
        return { person, account, session, expiresAt };
      });
      if (outcome === null) throw verificationError();
      return {
        verified: true,
        personId: outcome.person.id,
        customerAccountId: outcome.account.id,
        sessionId: outcome.session.id,
        sessionToken,
        expiresAt: outcome.expiresAt.toISOString(),
      };
    },

    async authenticateSessionToken(token) {
      const session = await findActiveCustomerSessionByTokenHash(
        options.database,
        hashSessionToken(token),
        clock.now(),
      );
      if (session === null) throw authenticationError();
      return {
        kind: "customer",
        customerAccountId: session.customerAccountId,
        personId: session.personId,
        sessionId: session.id,
      };
    },
  };
}

export function validateOtpPolicy(policy: OtpPolicy): Readonly<OtpPolicy> {
  positiveInteger(policy.ttlMs, "otp ttlMs");
  positiveInteger(policy.attemptLimit, "otp attemptLimit");
  positiveInteger(policy.resendCooldownMs, "otp resendCooldownMs");
  positiveInteger(policy.sessionTtlMs, "customer sessionTtlMs");
  if (
    !Number.isInteger(policy.codeLength) ||
    policy.codeLength < 4 ||
    policy.codeLength > 9
  ) {
    throw new Error("otp codeLength must be an integer between 4 and 9");
  }
  if (policy.hashSecret.length < 32) {
    throw new Error("otp hashSecret must be at least 32 characters");
  }
  if (
    policy.deliveryDerivationSecret.length < 32 ||
    policy.deliveryDerivationSecret === policy.hashSecret
  ) {
    throw new Error(
      "otp deliveryDerivationSecret must be distinct and at least 32 characters",
    );
  }
  return Object.freeze({ ...policy });
}

function hashOtp(
  secret: string,
  challengeId: string,
  personId: string,
  code: string,
): string {
  return createHmac("sha256", secret)
    .update(challengeId)
    .update("\0")
    .update(personId)
    .update("\0")
    .update(code)
    .digest("hex");
}

function equalHashes(expected: string, actual: string): boolean {
  const left = Buffer.from(expected, "hex");
  const right = Buffer.from(actual, "hex");
  return (
    left.length === right.length &&
    timingSafeEqual(Uint8Array.from(left), Uint8Array.from(right))
  );
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizePhone(phoneE164: string): string {
  const normalized = phoneE164.trim();
  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) throw verificationError();
  return normalized;
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}

function verificationError(): AppError {
  return new AppError(
    401,
    "OTP_VERIFICATION_FAILED",
    "The code could not be verified.",
  );
}

function authenticationError(): AppError {
  return new AppError(
    401,
    "AUTHENTICATION_FAILED",
    "Credentials could not be verified.",
  );
}

const absentSubjectId = "00000000-0000-4000-8000-000000000000";
const absentChallengeId = "00000000-0000-4000-8000-000000000001";

function observe(
  options: { workObserver?: (step: OtpWorkStep) => void },
  step: OtpWorkStep,
): void {
  options.workObserver?.(step);
}
