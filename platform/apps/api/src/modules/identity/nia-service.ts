import { createHmac, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  claimIdentityCheck,
  completeIdentityCheck,
  findIdentityCheckByIdempotencyKey,
  findIdentityCheckByProviderReference,
  findOwnedConsentEvidence,
  markDuplicateIdentityCheck,
  releaseIdentityCheckClaim,
  reserveIdentityCheck,
  withTransaction,
  type Database,
} from "@somo/db";
import type { NiaPort } from "@somo/integrations";
import { AppError } from "../../plugins/errors.js";
import {
  createConsentDocumentCatalog,
  type ConsentDocumentCatalogConfig,
} from "./consent-catalog.js";

const NIA_PURPOSE = "NIA_IDENTITY_VERIFICATION";
const NIA_PROVIDER = "NIA";

export type NiaDecision = "MATCH" | "NO_MATCH" | "REVIEW";
export type IdentityCheckStatus = "VERIFIED" | "FAILED" | "MANUAL_REVIEW";

export interface IdentityService {
  verifyGhanaCard(input: {
    subjectPersonId: string;
    consentId: string;
    ghanaCardNumber: string;
    idempotencyKey: string;
    sessionId?: string;
    requestId: string;
  }): Promise<IdentityResult>;
}

interface IdentityResult {
  identityCheckId: string;
  status: IdentityCheckStatus;
  decision: NiaDecision;
  providerReference: string;
  checkedAt: string;
}

export interface NiaClock {
  now(): Date;
}

export function createNiaService(options: {
  database: Database;
  nia: NiaPort;
  catalog: ConsentDocumentCatalogConfig;
  idempotencyHashSecret: string;
  clock?: NiaClock;
}): IdentityService {
  const clock = options.clock ?? { now: () => new Date() };
  const catalog = createConsentDocumentCatalog(options.catalog);
  if (options.idempotencyHashSecret.length < 32) {
    throw new Error("NIA_IDEMPOTENCY_HASH_SECRET_INVALID");
  }
  return {
    async verifyGhanaCard(input) {
      validateVerificationInput(input);
      const consent = await findOwnedConsentEvidence(options.database, {
        consentId: input.consentId,
        personId: input.subjectPersonId,
        purpose: NIA_PURPOSE,
      });
      if (
        consent === null ||
        consent.withdrawnAt !== null ||
        !catalog.isCurrent(consent.purpose, consent.documentVersion)
      ) {
        throw new AppError(
          400,
          "NIA_CONSENT_REQUIRED",
          "Current identity-verification consent is required.",
        );
      }

      const reservedAt = clock.now();
      const proposedId = randomUUID();
      const requestFingerprint = niaRequestFingerprint(
        options.idempotencyHashSecret,
        input,
      );
      const reservation = await withTransaction(
        options.database,
        async (tx) => {
          const reserved = await reserveIdentityCheck(tx, {
            id: proposedId,
            personId: input.subjectPersonId,
            provider: NIA_PROVIDER,
            idempotencyKey: input.idempotencyKey,
            providerCorrelationId: proposedId,
            consentEvidenceId: consent.id,
            evidence: {
              purpose: NIA_PURPOSE,
              consentEvidenceId: consent.id,
              requestFingerprint,
            },
            createdAt: reservedAt,
          });
          if (reserved.reserved) {
            await appendAuditEvent(tx, {
              aggregateType: "identity_check",
              aggregateId: reserved.record.id,
              action: "NIA_IDENTITY_CHECK_RESERVED",
              requestId: input.requestId,
              data: auditData(input, {
                purpose: NIA_PURPOSE,
                consentEvidenceId: consent.id,
              }),
              occurredAt: reservedAt,
            });
          }
          return reserved;
        },
      );
      if (
        reservation.record.personId !== input.subjectPersonId ||
        reservation.record.consentEvidenceId !== consent.id ||
        reservation.record.evidence["requestFingerprint"] !== requestFingerprint
      ) {
        throw new AppError(
          409,
          "NIA_IDEMPOTENCY_CONFLICT",
          "The idempotency key is already in use.",
        );
      }
      const existingResult = resultFromRecord(reservation.record);
      if (existingResult !== null) return existingResult;

      const processingToken = randomUUID();
      let claimed = await claimIdentityCheck(options.database, {
        identityCheckId: reservation.record.id,
        processingToken,
        startedAt: clock.now(),
      });
      if (claimed === null) {
        const completed = await waitForIdentityResult(
          options.database,
          input.idempotencyKey,
        );
        const completedResult = resultFromRecord(completed);
        if (completedResult !== null) return completedResult;
        claimed = await claimIdentityCheck(options.database, {
          identityCheckId: completed.id,
          processingToken,
          startedAt: clock.now(),
        });
        if (claimed === null) {
          throw new AppError(
            409,
            "NIA_VERIFICATION_IN_PROGRESS",
            "Identity verification is already in progress.",
          );
        }
      }

      let providerResult: ReturnType<typeof normalizeProviderResult>;
      try {
        providerResult = normalizeProviderResult(
          await options.nia.verify({
            correlationId: claimed.providerCorrelationId,
            ghanaCardNumber: input.ghanaCardNumber,
            consentId: consent.id,
          }),
        );
      } catch {
        await releaseIdentityCheckClaim(options.database, {
          identityCheckId: claimed.id,
          processingToken,
        });
        const failedAt = clock.now();
        await appendAuditEvent(options.database, {
          aggregateType: "identity_check",
          aggregateId: claimed.id,
          action: "NIA_VERIFICATION_UNAVAILABLE",
          requestId: input.requestId,
          data: auditData(input, {
            purpose: NIA_PURPOSE,
            consentEvidenceId: consent.id,
            decision: "UNAVAILABLE",
            checkedAt: failedAt.toISOString(),
          }),
          occurredAt: failedAt,
        });
        throw new AppError(
          503,
          "NIA_UNAVAILABLE",
          "Identity verification is temporarily unavailable.",
        );
      }

      const duplicate = await findIdentityCheckByProviderReference(
        options.database,
        {
          provider: NIA_PROVIDER,
          providerReference: providerResult.providerReference,
        },
      );
      if (duplicate !== null && duplicate.id !== claimed.id) {
        if (duplicate.personId !== input.subjectPersonId) {
          await releaseIdentityCheckClaim(options.database, {
            identityCheckId: claimed.id,
            processingToken,
          });
          throw new AppError(
            503,
            "NIA_UNAVAILABLE",
            "Identity verification is temporarily unavailable.",
          );
        }
        const duplicateResult = resultFromRecord(duplicate);
        if (duplicateResult === null)
          throw new Error("NIA_DUPLICATE_INCOMPLETE");
        await withTransaction(options.database, async (tx) => {
          const occurredAt = clock.now();
          await markDuplicateIdentityCheck(tx, {
            identityCheckId: claimed.id,
            processingToken,
            duplicateOfIdentityCheckId: duplicate.id,
            consentEvidenceId: consent.id,
            checkedAt: occurredAt,
          });
          await appendAuditEvent(tx, {
            aggregateType: "identity_check",
            aggregateId: claimed.id,
            action: "NIA_DUPLICATE_RESULT_REUSED",
            requestId: input.requestId,
            data: auditData(input, {
              purpose: NIA_PURPOSE,
              consentEvidenceId: consent.id,
              duplicateOfIdentityCheckId: duplicate.id,
            }),
            occurredAt,
          });
        });
        return duplicateResult;
      }

      const status = statusForDecision(providerResult.decision);
      const checkedAt = new Date(providerResult.checkedAt);
      const completed = await withTransaction(options.database, async (tx) => {
        const record = await completeIdentityCheck(tx, {
          identityCheckId: claimed.id,
          processingToken,
          providerReference: providerResult.providerReference,
          status,
          evidence: {
            decision: providerResult.decision,
            purpose: NIA_PURPOSE,
            consentEvidenceId: consent.id,
            requestFingerprint,
          },
          checkedAt,
        });
        await appendAuditEvent(tx, {
          aggregateType: "identity_check",
          aggregateId: claimed.id,
          action: "NIA_IDENTITY_CHECK_RECORDED",
          requestId: input.requestId,
          data: auditData(input, {
            purpose: NIA_PURPOSE,
            consentEvidenceId: consent.id,
            providerReference: providerResult.providerReference,
            decision: providerResult.decision,
            checkedAt: providerResult.checkedAt,
          }),
          occurredAt: clock.now(),
        });
        return record;
      });
      const result = resultFromRecord(completed);
      if (result === null) throw new Error("NIA_RESULT_INCOMPLETE");
      return result;
    },
  };
}

async function waitForIdentityResult(
  database: Database,
  idempotencyKey: string,
) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const record = await findIdentityCheckByIdempotencyKey(database, {
      provider: NIA_PROVIDER,
      idempotencyKey,
    });
    if (record === null) throw new Error("NIA_RESERVATION_MISSING");
    if (record.status !== "PENDING" || record.processingToken === null) {
      return record;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new AppError(
    409,
    "NIA_VERIFICATION_IN_PROGRESS",
    "Identity verification is already in progress.",
  );
}

function resultFromRecord(record: {
  id: string;
  providerReference: string | null;
  status: "PENDING" | "VERIFIED" | "FAILED" | "MANUAL_REVIEW";
  evidence: Record<string, unknown>;
  checkedAt: Date | null;
}): IdentityResult | null {
  if (record.status === "PENDING") return null;
  const decision = record.evidence["decision"];
  if (
    record.providerReference === null ||
    record.checkedAt === null ||
    !["MATCH", "NO_MATCH", "REVIEW"].includes(String(decision))
  ) {
    return null;
  }
  return Object.freeze({
    identityCheckId: record.id,
    status: record.status,
    decision: decision as NiaDecision,
    providerReference: record.providerReference,
    checkedAt: record.checkedAt.toISOString(),
  });
}

function validateVerificationInput(input: {
  subjectPersonId: string;
  consentId: string;
  ghanaCardNumber: string;
  idempotencyKey: string;
  sessionId?: string;
  requestId: string;
}): void {
  if (
    !uuid(input.subjectPersonId) ||
    !uuid(input.consentId) ||
    !uuid(input.idempotencyKey) ||
    !uuid(input.requestId) ||
    (input.sessionId !== undefined && !uuid(input.sessionId)) ||
    !/^GHA-[0-9]{9}-[0-9]$/.test(input.ghanaCardNumber)
  ) {
    throw new AppError(
      400,
      "NIA_VERIFICATION_INPUT_INVALID",
      "The identity verification request is invalid.",
    );
  }
}

function normalizeProviderResult(result: {
  providerReference: string;
  decision: "MATCH" | "NO_MATCH" | "REVIEW";
  checkedAt: string;
}) {
  const providerReference = result.providerReference.trim();
  const checkedAt = new Date(result.checkedAt);
  if (
    providerReference.length === 0 ||
    providerReference.length > 256 ||
    !["MATCH", "NO_MATCH", "REVIEW"].includes(result.decision) ||
    Number.isNaN(checkedAt.getTime())
  ) {
    throw new Error("NIA_PROVIDER_RESPONSE_INVALID");
  }
  return {
    providerReference,
    decision: result.decision,
    checkedAt: checkedAt.toISOString(),
  };
}

function statusForDecision(decision: NiaDecision): IdentityCheckStatus {
  if (decision === "MATCH") return "VERIFIED";
  if (decision === "NO_MATCH") return "FAILED";
  return "MANUAL_REVIEW";
}

function auditData(
  input: { subjectPersonId: string; sessionId?: string },
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    subjectPersonId: input.subjectPersonId,
    ...data,
    ...(input.sessionId === undefined
      ? {}
      : { customerSessionId: input.sessionId }),
  };
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function niaRequestFingerprint(
  secret: string,
  input: {
    subjectPersonId: string;
    consentId: string;
    ghanaCardNumber: string;
  },
): string {
  return createHmac("sha256", secret)
    .update(input.subjectPersonId)
    .update("\0")
    .update(input.consentId)
    .update("\0")
    .update(input.ghanaCardNumber)
    .digest("hex");
}
