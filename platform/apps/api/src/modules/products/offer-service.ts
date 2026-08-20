import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  enqueueOutbox,
  financingRepo,
  withTransaction,
  type Database,
  type OfferRecord,
} from "@somo/db";
import {
  FinanceApprovalGate,
  FinancingEngine,
  canonicalizeJson,
  isTrustedFinanceApprovalGate,
  type QuoteResult,
} from "@somo/domain/src/index.js";
import type { CustomerPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";
import type { ExceptionService } from "./exception-service.js";
import type { ProductService } from "./service.js";

export interface OfferService {
  create(input: {
    applicationId: string;
    depositMinor: string | bigint;
    frequency: "WEEKLY" | "MONTHLY";
    tenureMonths: 6 | 8 | 12 | 24 | 36 | 48;
    firstDueDate: string;
    expiresAt: string;
    idempotencyKey: string;
    actor: CustomerPrincipal;
    requestId: string;
  }): Promise<OfferRecord>;
  accept(input: {
    offerId: string;
    expectedVersion: number;
    consent: boolean;
    consentAt: string;
    disclosedVersion: string;
    disclosedHash: string;
    idempotencyKey: string;
    actor: CustomerPrincipal;
    requestId: string;
  }): Promise<OfferRecord>;
  get(applicationId: string): Promise<OfferRecord | null>;
  getForCustomer(
    applicationId: string,
    actor: CustomerPrincipal,
  ): Promise<OfferRecord | null>;
}

export function createOfferService(options: {
  database: Database;
  products: ProductService;
  exceptions: ExceptionService;
  fixtureGate?: FinanceApprovalGate;
}): OfferService {
  if (options.fixtureGate !== undefined && !isTrustedFinanceApprovalGate(options.fixtureGate)) {
    throw new Error("FINANCE_FIXTURE_GATE_INVALID");
  }
  const fixtureGate = options.fixtureGate ?? FinanceApprovalGate.production();
  return {
    async create(input) {
      const depositMinor = parseMinor(input.depositMinor);
      const expiresAt = parseDate(input.expiresAt, "OFFER_EXPIRY_INVALID");
      const now = new Date();
      if (expiresAt <= now) {
        throw new AppError(400, "OFFER_EXPIRY_INVALID", "The offer expiry must be in the future.");
      }
      const firstDueDate = validateDateOnly(input.firstDueDate);
      const payloadHash = hashPayload({
        applicationId: input.applicationId,
        depositMinor: depositMinor.toString(),
        frequency: input.frequency,
        tenureMonths: input.tenureMonths,
        firstDueDate,
        expiresAt: expiresAt.toISOString(),
      });
      const scope = `application:${input.applicationId}:offer-create`;
      const existing = await financingRepo(options.database).findCommand(scope, input.idempotencyKey);
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw idempotencyConflict();
        if (existing.actorPersonId !== input.actor.personId) throw idempotencyActorConflict();
        return replayOffer(options.database, existing.response);
      }
      const offerId = randomUUID();
      const offerVersionId = randomUUID();
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = financingRepo(tx);
          const application = await repo.lockApplication(input.applicationId);
          if (application === null) throw new AppError(404, "APPLICATION_NOT_FOUND", "Application not found.");
          if (application.applicantPersonId !== input.actor.personId) {
            throw new AppError(403, "FORBIDDEN", "This offer does not belong to the customer.");
          }
          if (application.status !== "APPROVED") {
            throw new AppError(409, "MD_APPROVAL_REQUIRED", "MD approval is required before an offer can be created.");
          }
          if (application.productId === null) {
            throw new AppError(409, "PRODUCT_REQUIRED", "A product rule is required before an offer can be created.");
          }
          const rule = await options.products.getEffectiveRule(application.productId, now);
          if (!rule.licencePermitted || rule.fixtureHashes.length === 0) {
            throw new AppError(403, "FINANCING_GATE_CLOSED", "The financing rule is not licensed and approved.");
          }
          const disclosure = assertOfferDisclosure(rule);
          if (!rule.repaymentFrequencies.includes(input.frequency)) {
            throw new AppError(400, "FREQUENCY_NOT_ALLOWED", "The repayment frequency is not permitted.");
          }
          if (!rule.allowedTenuresMonths.includes(input.tenureMonths)) {
            throw new AppError(400, "TENURE_NOT_ALLOWED", "The tenure is not permitted.");
          }
          const fixture = fixtureGate.assertEnabled({
            method: rule.calculationMethod,
            frequency: input.frequency,
            tenureMonths: input.tenureMonths,
          });
          if (!rule.fixtureHashes.includes(fixture.canonicalHash)) {
            throw new AppError(403, "FIXTURE_HASH_REQUIRED", "A registered approved fixture is required.");
          }
          const approvedException = await options.exceptions.findApproved(input.applicationId, now, {
            ruleVersionId: rule.id,
            field: "minimumDepositMinor",
            valueType: "AMOUNT",
            proposedAmountMinor: depositMinor,
            policyAmountMinor: rule.minimumDepositMinor,
          });
          if (depositMinor < rule.minimumDepositMinor && approvedException === null) {
            throw new AppError(400, "MINIMUM_DEPOSIT_REQUIRED", "The deposit is below the product minimum.");
          }
          if (depositMinor > rule.sellingPriceMinor) {
            throw new AppError(400, "DEPOSIT_EXCEEDS_PRICE", "The deposit cannot exceed the selling price.");
          }
          const pricing =
            rule.calculationMethod === "FLAT_MARKUP"
              ? { method: "FLAT_MARKUP" as const, markupBasisPoints: rule.annualRateBps }
              : { method: "REDUCING_BALANCE" as const, annualRateBasisPoints: rule.annualRateBps };
          const quote = FinancingEngine.quote({
            priceMinor: rule.sellingPriceMinor,
            depositMinor,
            pricing,
            frequency: input.frequency,
            tenureMonths: input.tenureMonths,
            firstDueDate,
          });
          const terms = serializeTerms({
            applicationId: input.applicationId,
            rule,
            quote,
            depositMinor,
            frequency: input.frequency,
            tenureMonths: input.tenureMonths,
            firstDueDate,
            expiresAt: expiresAt.toISOString(),
            fixtureHash: fixture.canonicalHash,
            exceptionId: approvedException?.id ?? null,
            disclosureContent: disclosure.content,
            disclosureHash: disclosure.hash,
          });
          const disclosedHash = disclosure.hash;
          terms.disclosureHash = disclosure.hash;
          const canonicalHash = hashPayload(terms);
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "OFFER_CREATE",
            payloadHash,
            actorPersonId: input.actor.personId,
            applicationId: input.applicationId,
            response: {},
          });
          if (!command.inserted) {
            if (command.payloadHash !== payloadHash) throw idempotencyConflict();
            if (command.actorPersonId !== input.actor.personId) throw idempotencyActorConflict();
            return replayOffer(options.database, command.response);
          }
          const created = await repo.insertOffer({
            offerId,
            offerVersionId,
            applicationId: input.applicationId,
            ruleId: rule.id,
            principalMinor: quote.principalMinor,
            depositMinor,
            totalPayableMinor: quote.totalPayableMinor,
            terms,
            canonicalHash,
            expiresAt,
            disclosedVersion: rule.disclosureVersion,
            disclosedHash,
          });
          const response = serializeOffer(created);
          await repo.updateCommandResponse(scope, input.idempotencyKey, response);
          await appendAuditEvent(tx, {
            aggregateType: "offer",
            aggregateId: created.id,
            action: "OFFER_CREATED",
            actorPersonId: input.actor.personId,
            requestId: input.requestId,
            data: {
              applicationId: input.applicationId,
              ruleVersionId: rule.id,
              fixtureHash: fixture.canonicalHash,
            },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "financing.offer.created",
            aggregateType: "offer",
            aggregateId: created.id,
            payload: response,
            occurredAt: now,
          });
          return created;
        });
      } catch (error) {
        const raced = await financingRepo(options.database).findCommand(scope, input.idempotencyKey);
        if (raced !== null && raced.payloadHash === payloadHash && raced.actorPersonId === input.actor.personId) {
          return replayOffer(options.database, raced.response);
        }
        throw mapError(error, "OFFER_CREATE_FAILED");
      }
    },

    async accept(input) {
      if (input.consent !== true) {
        throw new AppError(400, "CONSENT_REQUIRED", "Affirmative financing consent is required.");
      }
      const consentAt = parseDate(input.consentAt, "CONSENT_DATE_INVALID");
      const now = new Date();
      if (consentAt > now) {
        throw new AppError(400, "CONSENT_DATE_INVALID", "Consent cannot be in the future.");
      }
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new AppError(400, "VERSION_INVALID", "The offer version is invalid.");
      }
      const scope = `offer:${input.offerId}:accept`;
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = financingRepo(tx);
          const current = await repo.lockOffer(input.offerId);
          if (current === null) throw new AppError(404, "OFFER_NOT_FOUND", "Offer not found.");
          if (current.offerVersion === null || current.offerVersion.canonicalHash === null) {
            throw new AppError(409, "OFFER_LOCK_INVALID", "The offer terms are incomplete.");
          }
          const disclosure = assertOfferDisclosure({
            disclosureVersion: current.disclosedVersion,
            disclosureContent: isRecord(current.offerVersion.terms.disclosureContent)
              ? current.offerVersion.terms.disclosureContent
              : null,
            disclosureHash: current.disclosedHash,
            permittedFees: isRecord(current.offerVersion.terms.fees)
              ? current.offerVersion.terms.fees
              : null,
          });
          if (current.offerVersion.terms.disclosureHash !== disclosure.hash) {
            throw new AppError(409, "DISCLOSURE_INVALID", "The offer disclosure hash is inconsistent.");
          }
          if (
            input.disclosedVersion !== disclosure.version ||
            input.disclosedHash !== disclosure.hash
          ) {
            throw new AppError(409, "DISCLOSURE_MISMATCH", "The accepted disclosure does not match the offer.");
          }
          const payloadHash = hashPayload({
            offerId: input.offerId,
            expectedVersion: input.expectedVersion,
            lockedOfferVersion: current.offerVersion.versionNumber,
            canonicalHash: current.offerVersion.canonicalHash,
            disclosedVersion: disclosure.version,
            disclosedHash: disclosure.hash,
            acceptedDisclosureVersion: input.disclosedVersion,
            acceptedDisclosureHash: input.disclosedHash,
            consent: input.consent,
            consentAt: consentAt.toISOString(),
            actorPersonId: input.actor.personId,
          });
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "OFFER_ACCEPT",
            payloadHash,
            actorPersonId: input.actor.personId,
            applicationId: current.applicationId,
            response: {},
          });
          if (!command.inserted) {
            if (command.payloadHash !== payloadHash) throw idempotencyConflict();
            if (command.actorPersonId !== input.actor.personId) throw idempotencyActorConflict();
            return replayOffer(options.database, command.response);
          }
          const application = await repo.lockApplication(current.applicationId);
          if (application === null || application.applicantPersonId !== input.actor.personId) {
            throw new AppError(403, "FORBIDDEN", "This offer does not belong to the customer.");
          }
          const accepted = await repo.acceptOffer({
            offerId: input.offerId,
            expectedVersion: input.expectedVersion,
            personId: input.actor.personId,
            acceptedAt: now,
            consentAt,
            acceptedHash: current.offerVersion.canonicalHash,
          });
          const response = serializeOffer(accepted);
          await repo.updateCommandResponse(scope, input.idempotencyKey, response);
          await appendAuditEvent(tx, {
            aggregateType: "offer",
            aggregateId: accepted.id,
            action: "OFFER_ACCEPTED",
            actorPersonId: input.actor.personId,
            requestId: input.requestId,
            data: {
              acceptedVersionId: accepted.acceptedVersionId,
              canonicalHash: accepted.acceptedHash,
              disclosedVersion: input.disclosedVersion,
              disclosedHash: input.disclosedHash,
              consent: input.consent,
              consentAt: consentAt.toISOString(),
            },
            occurredAt: now,
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "financing.offer.accepted",
            aggregateType: "offer",
            aggregateId: accepted.id,
            payload: response,
            occurredAt: now,
          });
          return accepted;
        });
      } catch (error) {
        throw mapError(error, "OFFER_ACCEPT_FAILED");
      }
    },

    async get(applicationId) {
      return financingRepo(options.database).findOffer(applicationId);
    },

    async getForCustomer(applicationId, actor) {
      const application = await financingRepo(options.database).lockApplication(applicationId);
      if (application === null || application.applicantPersonId !== actor.personId) {
        throw new AppError(403, "FORBIDDEN", "This offer does not belong to the customer.");
      }
      return financingRepo(options.database).findOffer(applicationId);
    },
  };
}

function parseMinor(value: string | bigint): bigint {
  const parsed = typeof value === "bigint" ? value : /^\d+$/.test(value) ? BigInt(value) : -1n;
  if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) {
    throw new AppError(400, "DEPOSIT_INVALID", "The deposit is invalid.");
  }
  return parsed;
}

function parseDate(value: string, code: string): Date {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(date.getTime())) {
    throw new AppError(400, code, "The date is invalid.");
  }
  return date;
}

function validateDateOnly(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new AppError(400, "DATE_INVALID", "The due date is invalid.");
  }
  return value;
}

function assertOfferDisclosure(input: {
  disclosureVersion?: string | null | undefined;
  disclosureContent?: unknown;
  disclosureHash?: string | null | undefined;
  permittedFees?: unknown;
}): { version: string; content: Record<string, unknown>; hash: string } {
  if (
    typeof input.disclosureVersion !== "string" ||
    input.disclosureVersion.trim().length === 0 ||
    !isRecord(input.disclosureContent) ||
    !isRecord(input.permittedFees) ||
    typeof input.disclosureHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(input.disclosureHash)
  ) {
    throw new AppError(403, "DISCLOSURE_REQUIRED", "A versioned disclosure and structured fee policy are required.");
  }
  const expectedHash = hashPayload({
    version: input.disclosureVersion,
    content: input.disclosureContent,
  });
  if (expectedHash !== input.disclosureHash) {
    throw new AppError(403, "DISCLOSURE_INVALID", "The disclosure hash does not match its content.");
  }
  return {
    version: input.disclosureVersion,
    content: input.disclosureContent,
    hash: input.disclosureHash,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeTerms(input: {
  applicationId: string;
  rule: Awaited<ReturnType<ProductService["getEffectiveRule"]>>;
  quote: QuoteResult;
  depositMinor: bigint;
  frequency: "WEEKLY" | "MONTHLY";
  tenureMonths: number;
  firstDueDate: string;
  expiresAt: string;
  fixtureHash: string;
  exceptionId: string | null;
  disclosureContent: Record<string, unknown>;
  disclosureHash: string;
}): Record<string, unknown> {
  return {
    applicationId: input.applicationId,
    ruleVersionId: input.rule.id,
    ruleVersionNumber: input.rule.versionNumber,
    priceMinor: input.rule.sellingPriceMinor.toString(),
    depositMinor: input.depositMinor.toString(),
    frequency: input.frequency,
    tenureMonths: input.tenureMonths,
    firstDueDate: input.firstDueDate,
    expiresAt: input.expiresAt,
    method: input.rule.calculationMethod,
    rateBasisPoints: input.rule.annualRateBps,
    fees: input.rule.permittedFees,
    disclosureVersion: input.rule.disclosureVersion,
    disclosureContent: input.disclosureContent,
    disclosureHash: input.disclosureHash,
    fixtureHash: input.fixtureHash,
    exceptionId: input.exceptionId,
    principalMinor: input.quote.principalMinor.toString(),
    financeChargeMinor: input.quote.financeChargeMinor.toString(),
    totalPayableMinor: input.quote.totalPayableMinor.toString(),
    installments: input.quote.installments.map((item) => ({
      sequence: item.sequence,
      dueDate: item.dueDate,
      principalMinor: item.principalMinor.toString(),
      chargeMinor: item.chargeMinor.toString(),
      totalMinor: item.totalMinor.toString(),
    })),
  };
}

function serializeOffer(offer: OfferRecord): Record<string, unknown> {
  return {
    offerId: offer.id,
    applicationId: offer.applicationId,
    status: offer.status,
    version: offer.version,
    expiresAt: offer.expiresAt?.toISOString() ?? null,
    acceptedAt: offer.acceptedAt?.toISOString() ?? null,
    acceptedVersionId: offer.acceptedVersionId,
    acceptedHash: offer.acceptedHash,
    terms: offer.offerVersion?.terms ?? null,
  };
}

async function replayOffer(database: Database, response: Record<string, unknown>): Promise<OfferRecord> {
  const applicationId = response["applicationId"];
  if (typeof applicationId !== "string") throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved command response is invalid.");
  const offer = await financingRepo(database).findOffer(applicationId);
  if (offer === null) throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved offer is missing.");
  return offer;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return canonicalizeJson(value);
}

function idempotencyConflict(): AppError {
  return new AppError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "The idempotency key was reused with a different command.");
}

function idempotencyActorConflict(): AppError {
  return new AppError(409, "IDEMPOTENCY_ACTOR_MISMATCH", "The idempotency key belongs to a different actor.");
}

function mapError(error: unknown, fallback: string): AppError | unknown {
  if (error instanceof AppError) return error;
  if (error instanceof Error && (error.message.includes("23505") || error.message.includes("offer_application_unique"))) {
    return new AppError(409, "OFFER_ALREADY_EXISTS", "An offer already exists for this application.");
  }
  if (error instanceof Error && error.message === "OFFER_ACCEPT_REJECTED") {
    return new AppError(409, "OFFER_STALE_OR_EXPIRED", "The offer is stale, expired, or already accepted.");
  }
  return error instanceof Error ? error : new Error(fallback);
}
