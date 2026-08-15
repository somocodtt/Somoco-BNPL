import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  createIdentityCheck,
  findOwnedConsentEvidence,
  withTransaction,
  type Database,
} from "@somo/db";
import type { NiaPort } from "@somo/integrations";
import { AppError } from "../../plugins/errors.js";

const NIA_PURPOSE = "NIA_IDENTITY_VERIFICATION";

export type NiaDecision = "MATCH" | "NO_MATCH" | "REVIEW";
export type IdentityCheckStatus = "VERIFIED" | "FAILED" | "MANUAL_REVIEW";

export interface IdentityService {
  verifyGhanaCard(input: {
    subjectPersonId: string;
    consentId: string;
    ghanaCardNumber: string;
    sessionId?: string;
    requestId: string;
  }): Promise<{
    identityCheckId: string;
    status: IdentityCheckStatus;
    decision: NiaDecision;
    providerReference: string;
    checkedAt: string;
  }>;
}

export interface NiaClock {
  now(): Date;
}

export function createNiaService(options: {
  database: Database;
  nia: NiaPort;
  clock?: NiaClock;
}): IdentityService {
  const clock = options.clock ?? { now: () => new Date() };
  return {
    async verifyGhanaCard(input) {
      validateVerificationInput(input);
      const consent = await findOwnedConsentEvidence(options.database, {
        consentId: input.consentId,
        personId: input.subjectPersonId,
        purpose: NIA_PURPOSE,
      });
      if (consent === null || consent.withdrawnAt !== null) {
        throw new AppError(
          400,
          "NIA_CONSENT_REQUIRED",
          "Current identity-verification consent is required.",
        );
      }

      const identityCheckId = randomUUID();
      let result: {
        providerReference: string;
        decision: NiaDecision;
        checkedAt: string;
      };
      try {
        result = normalizeProviderResult(
          await options.nia.verify({
            correlationId: identityCheckId,
            ghanaCardNumber: input.ghanaCardNumber,
            consentId: consent.id,
          }),
        );
      } catch {
        const failedAt = clock.now();
        await appendAuditEvent(options.database, {
          aggregateType: "identity_check",
          aggregateId: identityCheckId,
          action: "NIA_VERIFICATION_UNAVAILABLE",
          requestId: input.requestId,
          data: auditData(input, {
            purpose: NIA_PURPOSE,
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

      const checkedAt = new Date(result.checkedAt);
      const status = statusForDecision(result.decision);
      const createdAt = clock.now();
      await withTransaction(options.database, async (tx) => {
        await createIdentityCheck(tx, {
          id: identityCheckId,
          personId: input.subjectPersonId,
          provider: "NIA",
          providerReference: result.providerReference,
          status,
          evidence: {
            decision: result.decision,
            purpose: NIA_PURPOSE,
          },
          checkedAt,
          createdAt,
        });
        await appendAuditEvent(tx, {
          aggregateType: "identity_check",
          aggregateId: identityCheckId,
          action: "NIA_IDENTITY_CHECK_RECORDED",
          requestId: input.requestId,
          data: auditData(input, {
            purpose: NIA_PURPOSE,
            providerReference: result.providerReference,
            decision: result.decision,
            checkedAt: result.checkedAt,
          }),
          occurredAt: createdAt,
        });
      });

      return Object.freeze({
        identityCheckId,
        status,
        decision: result.decision,
        providerReference: result.providerReference,
        checkedAt: result.checkedAt,
      });
    },
  };
}

function validateVerificationInput(input: {
  subjectPersonId: string;
  consentId: string;
  ghanaCardNumber: string;
  sessionId?: string;
  requestId: string;
}): void {
  if (
    !uuid(input.subjectPersonId) ||
    !uuid(input.consentId) ||
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
