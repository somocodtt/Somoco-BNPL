import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  appendAuditEvent,
  createCustomerSession,
  createOtpChallenge,
  enqueueOutbox,
  findActiveCustomerSessionByTokenHash,
  findLatestUsableOtpChallenge,
  findLatestOtpChallengeForCooldown,
  findOrCreateCustomerAccount,
  findPersonByPhone,
  invalidateOutstandingOtpChallenges,
  lockPersonByPhone,
  recordFailedOtpAttempt,
  withTransaction,
  type Database,
} from "@somo/db";
import { sealOtpDelivery, type SmsPort } from "@somo/integrations";
import type { CustomerPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface OtpPolicy {
  ttlMs: number;
  attemptLimit: number;
  resendCooldownMs: number;
  codeLength: number;
  hashSecret: string;
  deliveryEncryptionSecret: string;
  sessionTtlMs: number;
}

export interface Clock {
  now(): Date;
}

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
}): OtpService {
  const policy = validateOtpPolicy(options.policy);
  const clock = options.clock ?? { now: () => new Date() };

  return {
    async request(input) {
      const phoneE164 = normalizePhone(input.phoneE164);
      const now = clock.now();
      const person = await findPersonByPhone(options.database, phoneE164);
      const code = generateCode(policy.codeLength);
      const challengeId = randomUUID();
      if (person === null) {
        dummyHash(policy.hashSecret, code);
        await withTransaction(options.database, async (tx) => {
          await appendAuditEvent(tx, {
            aggregateType: "otp_challenge",
            aggregateId: challengeId,
            action: "OTP_REQUESTED",
            requestId: input.requestId,
            data: { purpose: "CUSTOMER_AUTHENTICATION" },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: challengeId,
            topic: "identity.otp_delivery_suppressed",
            aggregateType: "otp_challenge",
            aggregateId: challengeId,
            payload: {
              requestId: input.requestId,
              purpose: "CUSTOMER_AUTHENTICATION",
            },
            occurredAt: now,
          });
        });
        return acceptedResponse;
      }
      const created = await withTransaction(options.database, async (tx) => {
        const lockedPerson = await lockPersonByPhone(tx, phoneE164);
        if (lockedPerson === null) return false;
        const latest = await findLatestOtpChallengeForCooldown(
          tx,
          lockedPerson.id,
        );
        if (
          latest !== null &&
          now.getTime() - latest.createdAt.getTime() < policy.resendCooldownMs
        ) {
          return false;
        }
        await createOtpChallenge(tx, {
          id: challengeId,
          personId: lockedPerson.id,
          codeHash: hashOtp(
            policy.hashSecret,
            challengeId,
            lockedPerson.id,
            code,
          ),
          expiresAt: new Date(now.getTime() + policy.ttlMs),
          createdAt: now,
        });
        await appendAuditEvent(tx, {
          aggregateType: "otp_challenge",
          aggregateId: challengeId,
          action: "OTP_REQUESTED",
          requestId: input.requestId,
          data: { purpose: "CUSTOMER_AUTHENTICATION" },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: challengeId,
          topic: "identity.otp_sms_requested",
          aggregateType: "otp_challenge",
          aggregateId: challengeId,
          payload: {
            requestId: input.requestId,
            delivery: sealOtpDelivery(policy.deliveryEncryptionSecret, {
              phoneE164,
              template: "CUSTOMER_AUTHENTICATION_OTP",
              variables: { code },
            }),
          },
          occurredAt: now,
        });
        return true;
      });
      if (!created) return acceptedResponse;

      return acceptedResponse;
    },

    async verify(input) {
      const phoneE164 = normalizePhone(input.phoneE164);
      const now = clock.now();
      const sessionToken = randomBytes(32).toString("base64url");
      const outcome = await withTransaction(options.database, async (tx) => {
        const person = await lockPersonByPhone(tx, phoneE164);
        if (person === null) {
          dummyHash(policy.hashSecret, input.code);
          await appendAuditEvent(tx, {
            aggregateType: "otp_challenge",
            aggregateId: randomUUID(),
            action: "OTP_VERIFICATION_REJECTED",
            requestId: input.requestId,
            data: { reason: "INVALID_OR_EXPIRED" },
            occurredAt: now,
          });
          return null;
        }
        const challenge = await findLatestUsableOtpChallenge(tx, {
          personId: person.id,
          now,
        });
        if (challenge === null || challenge.attempts >= policy.attemptLimit) {
          dummyHash(policy.hashSecret, input.code);
          return null;
        }
        const suppliedHash = hashOtp(
          policy.hashSecret,
          challenge.id,
          person.id,
          input.code,
        );
        if (!equalHashes(challenge.codeHash, suppliedHash)) {
          const attempts = challenge.attempts + 1;
          await recordFailedOtpAttempt(tx, {
            challengeId: challenge.id,
            attempts,
            ...(attempts >= policy.attemptLimit ? { invalidatedAt: now } : {}),
          });
          await appendAuditEvent(tx, {
            aggregateType: "otp_challenge",
            aggregateId: challenge.id,
            action: "OTP_VERIFICATION_REJECTED",
            requestId: input.requestId,
            data: { reason: "INVALID_OR_EXPIRED" },
            occurredAt: now,
          });
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
    policy.deliveryEncryptionSecret.length < 32 ||
    policy.deliveryEncryptionSecret === policy.hashSecret
  ) {
    throw new Error(
      "otp deliveryEncryptionSecret must be distinct and at least 32 characters",
    );
  }
  return Object.freeze({ ...policy });
}

function generateCode(length: number): string {
  return randomInt(0, 10 ** length)
    .toString()
    .padStart(length, "0");
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

function dummyHash(secret: string, code: string): void {
  createHmac("sha256", secret)
    .update("unknown\0unknown\0")
    .update(code)
    .digest();
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
