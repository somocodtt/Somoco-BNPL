import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  enqueueOutbox,
  financingRepo,
  withTransaction,
  type Database,
  type FinancingRuleRecord,
} from "@somo/db";
import {
  FinanceApprovalGate,
  canonicalizeJson,
  isSupportedTenure,
  MAX_RATE_BASIS_POINTS,
  type FixtureKey,
} from "@somo/domain/src/index.js";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface ProductRuleDraftInput {
  productId: string;
  versionNumber: number;
  sellingPriceMinor: string | bigint;
  minimumDepositMinor: string | bigint;
  method: "FLAT_MARKUP" | "REDUCING_BALANCE";
  rateBasisPoints: number;
  allowedTenuresMonths: readonly number[];
  repaymentFrequencies: readonly ("WEEKLY" | "MONTHLY")[];
  permittedFees?: Record<string, unknown>;
  eligibilityPolicy?: Record<string, unknown>;
  requiredEvidence?: readonly string[];
  exceptionPolicy?: Record<string, unknown>;
  disclosureVersion?: string | undefined;
  fixtureHashes?: readonly string[];
  licencePermitted?: boolean;
}

export interface PublishRuleInput {
  ruleId: string;
  actor: StaffPrincipal;
  effectiveFrom: string;
  effectiveUntil?: string;
  idempotencyKey: string;
  requestId: string;
}

export interface ProductService {
  createRuleVersion(
    input: ProductRuleDraftInput & {
      actor: StaffPrincipal;
      requestId: string;
    },
  ): Promise<{ id: string; versionNumber: number }>;
  publishRuleVersion(input: PublishRuleInput): Promise<FinancingRuleRecord>;
  listRules(): Promise<FinancingRuleRecord[]>;
  getEffectiveRule(productId: string, now?: Date): Promise<FinancingRuleRecord>;
}

export function createProductService(options: {
  database: Database;
  fixtureGate?: FinanceApprovalGate;
}): ProductService {
  const fixtureGate = options.fixtureGate ?? FinanceApprovalGate.production();

  return {
    async createRuleVersion(input) {
      assertProductManager(input.actor);
      assertVersion(input.versionNumber);
      const sellingPriceMinor = parseMinor(input.sellingPriceMinor, "PRICE_INVALID");
      const minimumDepositMinor = parseMinor(
        input.minimumDepositMinor,
        "DEPOSIT_INVALID",
      );
      if (minimumDepositMinor > sellingPriceMinor) {
        throw new AppError(
          400,
          "MINIMUM_DEPOSIT_INVALID",
          "Minimum deposit cannot exceed the selling price.",
        );
      }
      if (
        input.method !== "FLAT_MARKUP" &&
        input.method !== "REDUCING_BALANCE"
      ) {
        throw new AppError(400, "METHOD_NOT_SUPPORTED", "The method is disabled.");
      }
      if (
        !Number.isSafeInteger(input.rateBasisPoints) ||
        input.rateBasisPoints < 0 ||
        input.rateBasisPoints > MAX_RATE_BASIS_POINTS
      ) {
        throw new AppError(400, "RATE_INVALID", "The rate is invalid.");
      }
      if (input.disclosureVersion === undefined || input.disclosureVersion.trim().length === 0) {
        throw new AppError(400, "DISCLOSURE_REQUIRED", "A disclosure version is required.");
      }
      if (input.permittedFees !== undefined && Object.keys(input.permittedFees).length > 0) {
        throw new AppError(400, "FEES_NOT_APPROVED", "Fees require an approved fee schedule.");
      }
      if (
        input.allowedTenuresMonths.length === 0 ||
        input.allowedTenuresMonths.some(
          (tenure) => !Number.isSafeInteger(tenure) || !isSupportedTenure(tenure),
        )
      ) {
        throw new AppError(400, "TENURE_INVALID", "The allowed tenures are invalid.");
      }
      if (
        input.repaymentFrequencies.length === 0 ||
        input.repaymentFrequencies.some(
          (frequency) => frequency !== "WEEKLY" && frequency !== "MONTHLY",
        )
      ) {
        throw new AppError(400, "FREQUENCY_INVALID", "The repayment frequencies are invalid.");
      }
      const id = randomUUID();
      try {
        return await withTransaction(options.database, async (tx) => {
          const created = await financingRepo(tx).insertRule({
            id,
            productId: input.productId,
            versionNumber: input.versionNumber,
            sellingPriceMinor,
            minimumDepositMinor,
            annualRateBps: input.rateBasisPoints,
            allowedTenuresMonths: input.allowedTenuresMonths,
            repaymentFrequencies: input.repaymentFrequencies,
            calculationMethod: input.method,
            permittedFees: input.permittedFees ?? {},
            eligibilityPolicy: input.eligibilityPolicy ?? {},
            requiredEvidence: input.requiredEvidence ?? [],
            exceptionPolicy: input.exceptionPolicy ?? {},
            ...(input.disclosureVersion === undefined
              ? {}
              : { disclosureVersion: input.disclosureVersion }),
            fixtureHashes: input.fixtureHashes ?? [],
            licencePermitted: input.licencePermitted ?? false,
            requestedBy: input.actor.staffUserId,
          });
          await appendAuditEvent(tx, {
            aggregateType: "financing_rule_version",
            aggregateId: created.id,
            action: "FINANCING_RULE_DRAFT_CREATED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              productId: input.productId,
              versionNumber: input.versionNumber,
            },
            occurredAt: new Date(),
          });
          return created;
        });
      } catch (error) {
        throw mapDatabaseError(error, "FINANCING_RULE_DRAFT_FAILED");
      }
    },

    async publishRuleVersion(input) {
      assertProductManager(input.actor);
      const effectiveFrom = parseDate(input.effectiveFrom, "EFFECTIVE_DATE_INVALID");
      const effectiveUntil =
        input.effectiveUntil === undefined
          ? undefined
          : parseDate(input.effectiveUntil, "EFFECTIVE_DATE_INVALID");
      if (effectiveUntil !== undefined && effectiveUntil <= effectiveFrom) {
        throw new AppError(400, "EFFECTIVE_WINDOW_INVALID", "Effective dates are invalid.");
      }
      const payloadHash = hashPayload({
        ruleId: input.ruleId,
        effectiveFrom: effectiveFrom.toISOString(),
        effectiveUntil: effectiveUntil?.toISOString() ?? null,
      });
      const scope = `rule:${input.ruleId}:publish`;
      const existing = await financingRepo(options.database).findCommand(
        scope,
        input.idempotencyKey,
      );
      if (existing !== null) {
        if (existing.payloadHash !== payloadHash) throw idempotencyConflict();
        if (existing.actorStaffUserId !== input.actor.staffUserId) throw idempotencyActorConflict();
        const rule = await financingRepo(options.database).findRule(input.ruleId);
        if (rule === null) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found.");
        return rule;
      }
      try {
        return await withTransaction(options.database, async (tx) => {
          const repo = financingRepo(tx);
          const draft = await repo.findRule(input.ruleId);
          if (draft === null) throw new AppError(404, "RULE_NOT_FOUND", "Rule not found.");
          if (draft.approved || draft.publishedAt !== null) {
            throw new AppError(409, "RULE_IMMUTABLE", "Published rule versions are immutable.");
          }
          if (!draft.licencePermitted) {
            throw new AppError(403, "LICENCE_PERMISSION_REQUIRED", "A licensed rule is required before publishing.");
          }
          if (draft.disclosureVersion === null || draft.disclosureVersion.trim().length === 0) {
            throw new AppError(403, "DISCLOSURE_REQUIRED", "A disclosure version is required before publishing.");
          }
          if (Object.keys(draft.permittedFees).length > 0) {
            throw new AppError(403, "FEES_NOT_APPROVED", "Fees require an approved fee schedule.");
          }
          const fixtures = draft.repaymentFrequencies.flatMap((frequency) =>
            draft.allowedTenuresMonths.map((tenureMonths) => {
              const fixtureKey: FixtureKey = {
                method: draft.calculationMethod,
                frequency,
                tenureMonths: tenureMonths as FixtureKey["tenureMonths"],
              };
              const fixture = fixtureGate.assertEnabled(fixtureKey);
              if (!draft.fixtureHashes.includes(fixture.canonicalHash)) {
                throw new AppError(403, "FIXTURE_HASH_REQUIRED", "A registered approved fixture is required.");
              }
              return fixture;
            }),
          );
          const command = await repo.insertCommand({
            scope,
            idempotencyKey: input.idempotencyKey,
            commandType: "PRODUCT_PUBLISH",
            payloadHash,
            actorStaffUserId: input.actor.staffUserId,
            response: {},
          });
          if (!command.inserted) {
            if (command.payloadHash !== payloadHash) throw idempotencyConflict();
            if (command.actorStaffUserId !== input.actor.staffUserId) throw idempotencyActorConflict();
            const replayId = command.response["id"];
            if (typeof replayId !== "string") throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved command response is invalid.");
            const replay = await repo.findRule(replayId);
            if (replay === null) throw new AppError(409, "IDEMPOTENCY_REPLAY_INVALID", "The saved rule is missing.");
            return replay;
          }
          const published = await repo.publishRule({
            ruleId: input.ruleId,
            actorStaffUserId: input.actor.staffUserId,
            effectiveFrom,
            ...(effectiveUntil === undefined ? {} : { effectiveUntil }),
          });
          const response = serializeRule(published);
          await repo.updateCommandResponse(scope, input.idempotencyKey, response);
          await appendAuditEvent(tx, {
            aggregateType: "financing_rule_version",
            aggregateId: published.id,
            action: "FINANCING_RULE_PUBLISHED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              versionNumber: published.versionNumber,
              fixtureHashes: fixtures.map((fixture) => fixture.canonicalHash),
            },
            occurredAt: new Date(),
          });
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "financing.rule.published",
            aggregateType: "financing_rule_version",
            aggregateId: published.id,
            payload: response,
            occurredAt: new Date(),
          });
          return published;
        });
      } catch (error) {
        const raced = await financingRepo(options.database).findCommand(scope, input.idempotencyKey);
        if (raced !== null && raced.payloadHash === payloadHash && raced.actorStaffUserId === input.actor.staffUserId) {
          const ruleId = raced.response["id"];
          if (typeof ruleId === "string") {
            const replay = await financingRepo(options.database).findRule(ruleId);
            if (replay !== null) return replay;
          }
        }
        throw mapDatabaseError(error, "RULE_PUBLISH_FAILED");
      }
    },

    async getEffectiveRule(productId, now = new Date()) {
      const rule = await financingRepo(options.database).findEffectiveRule(productId, now);
      if (rule === null) {
        throw new AppError(409, "NO_EFFECTIVE_FINANCING_RULE", "No effective licensed financing rule is available.");
      }
      return rule;
    },

    async listRules() {
      return financingRepo(options.database).listRules();
    },
  };
}

function assertProductManager(actor: StaffPrincipal): void {
  if (!actor.roles.includes("PRODUCT_ADMIN")) {
    throw new AppError(403, "FORBIDDEN", "Product management is not permitted.");
  }
}

function parseMinor(value: string | bigint, code: string): bigint {
  const parsed = typeof value === "bigint" ? value : /^\d+$/.test(value) ? BigInt(value) : -1n;
  if (parsed < 0n || parsed > 9_223_372_036_854_775_807n) {
    throw new AppError(400, code, "The money amount is invalid.");
  }
  return parsed;
}

function assertVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new AppError(400, "VERSION_INVALID", "The version is invalid.");
  }
}

function parseDate(value: string, code: string): Date {
  const parsed = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(parsed.getTime())) {
    throw new AppError(400, code, "The date is invalid.");
  }
  return parsed;
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return canonicalizeJson(value);
}

function serializeRule(rule: FinancingRuleRecord): Record<string, unknown> {
  return {
    id: rule.id,
    productId: rule.productId,
    versionNumber: rule.versionNumber,
    sellingPriceMinor: rule.sellingPriceMinor.toString(),
    minimumDepositMinor: rule.minimumDepositMinor.toString(),
    method: rule.calculationMethod,
    fixtureHashes: rule.fixtureHashes,
    effectiveFrom: rule.effectiveFrom?.toISOString() ?? null,
  };
}

function idempotencyConflict(): AppError {
  return new AppError(409, "IDEMPOTENCY_PAYLOAD_MISMATCH", "The idempotency key was reused with a different command.");
}

function idempotencyActorConflict(): AppError {
  return new AppError(409, "IDEMPOTENCY_ACTOR_MISMATCH", "The idempotency key belongs to a different actor.");
}

function mapDatabaseError(error: unknown, fallback: string): AppError | unknown {
  if (error instanceof AppError) return error;
  const code = error instanceof Error ? error.message : "";
  if (code === "PUBLISHED_FINANCING_RULE_IMMUTABLE") {
    return new AppError(409, "RULE_IMMUTABLE", "Published rule versions are immutable.");
  }
  if (code === "RULE_PUBLISH_REJECTED") {
    return new AppError(409, "RULE_PUBLISH_REJECTED", "The rule could not be published.");
  }
  return error instanceof Error ? error : new Error(fallback);
}
