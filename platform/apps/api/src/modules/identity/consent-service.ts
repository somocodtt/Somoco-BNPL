import { isIP } from "node:net";
import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  createConsentEvidence,
  findPersonById,
  withTransaction,
  type Database,
} from "@somo/db";
import { AppError } from "../../plugins/errors.js";
import {
  createConsentDocumentCatalog,
  type ConsentDocumentCatalogConfig,
} from "./consent-catalog.js";

export interface ConsentEvidence {
  consentId: string;
  subjectPersonId: string;
  documentVersion: string;
  acceptedAt: string;
  phoneE164: string;
  sessionId: string;
  ipAddress: string;
  userAgent: string;
}

export interface ConsentService {
  record(input: {
    subjectPersonId: string;
    purpose: string;
    documentVersion: string;
    phoneE164: string;
    sessionId: string;
    ipAddress: string;
    userAgent: string;
    requestId: string;
  }): Promise<ConsentEvidence>;
}

export interface ConsentClock {
  now(): Date;
}

export function createConsentService(options: {
  database: Database;
  catalog: ConsentDocumentCatalogConfig;
  clock?: ConsentClock;
}): ConsentService {
  const clock = options.clock ?? { now: () => new Date() };
  const catalog = createConsentDocumentCatalog(options.catalog);
  return {
    async record(input) {
      const normalized = validateConsentInput(input);
      if (!catalog.isCurrent(normalized.purpose, normalized.documentVersion)) {
        throw new AppError(
          400,
          "CONSENT_DOCUMENT_NOT_APPROVED",
          "The consent document is not approved.",
        );
      }
      const person = await findPersonById(
        options.database,
        normalized.subjectPersonId,
      );
      if (person === null || person.phoneE164 !== normalized.phoneE164) {
        throw new AppError(
          400,
          "CONSENT_SUBJECT_INVALID",
          "The consent subject could not be verified.",
        );
      }

      const consentId = randomUUID();
      const acceptedAt = clock.now();
      const evidence = Object.freeze({
        phoneE164: normalized.phoneE164,
        sessionId: normalized.sessionId,
        ipAddress: normalized.ipAddress,
        userAgent: normalized.userAgent,
      });
      await withTransaction(options.database, async (tx) => {
        await createConsentEvidence(tx, {
          id: consentId,
          personId: normalized.subjectPersonId,
          purpose: normalized.purpose,
          documentVersion: normalized.documentVersion,
          evidence,
          acceptedAt,
        });
        await appendAuditEvent(tx, {
          aggregateType: "consent_evidence",
          aggregateId: consentId,
          action: "CONSENT_RECORDED",
          requestId: normalized.requestId,
          data: {
            subjectPersonId: normalized.subjectPersonId,
            purpose: normalized.purpose,
            documentVersion: normalized.documentVersion,
            customerSessionId: normalized.sessionId,
          },
          occurredAt: acceptedAt,
        });
      });

      return Object.freeze({
        consentId,
        subjectPersonId: normalized.subjectPersonId,
        documentVersion: normalized.documentVersion,
        acceptedAt: acceptedAt.toISOString(),
        ...evidence,
      });
    },
  };
}

function validateConsentInput(input: {
  subjectPersonId: string;
  purpose: string;
  documentVersion: string;
  phoneE164: string;
  sessionId: string;
  ipAddress: string;
  userAgent: string;
  requestId: string;
}) {
  const purpose = input.purpose.trim();
  const documentVersion = input.documentVersion.trim();
  const phoneE164 = input.phoneE164.trim();
  const ipAddress = input.ipAddress.trim();
  const userAgent = input.userAgent.trim();
  if (
    !uuid(input.subjectPersonId) ||
    !uuid(input.sessionId) ||
    !uuid(input.requestId)
  ) {
    throw validationError();
  }
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(purpose)) throw validationError();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(documentVersion)) {
    throw validationError();
  }
  if (!/^\+[1-9][0-9]{7,14}$/.test(phoneE164)) throw validationError();
  if (isIP(ipAddress) === 0) throw validationError();
  if (userAgent.length === 0 || userAgent.length > 512) throw validationError();
  return {
    ...input,
    purpose,
    documentVersion,
    phoneE164,
    ipAddress,
    userAgent,
  };
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function validationError(): AppError {
  return new AppError(
    400,
    "CONSENT_EVIDENCE_INVALID",
    "The consent evidence is invalid.",
  );
}
