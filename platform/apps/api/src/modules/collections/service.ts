import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  collectionsRepo,
  enqueueOutbox,
  withTransaction,
  type Database,
} from "@somo/db";
import { computeArrears, type ArrearsResult } from "@somo/domain/src/index.js";
import type { TrackerPort } from "@somo/integrations";
import type { CustomerPrincipal, StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface CollectionsService {
  computeArrears(input: {
    contractId: string;
    asOfDate: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<ArrearsResult & { contractId: string }>;
  listArrears(
    actor: StaffPrincipal,
  ): Promise<readonly Record<string, unknown>[]>;
  openCase(input: {
    contractId: string;
    purpose: string;
    reason: string;
    assignedOfficerId?: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  listCases(actor: StaffPrincipal): Promise<readonly Record<string, unknown>[]>;
  decideEscalation(input: {
    recoveryCaseId: string;
    decision: "APPROVED" | "DENIED";
    purpose: string;
    reason: string;
    idempotencyKey: string;
    checker: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  recordAction(input: {
    recoveryCaseId: string;
    actionType:
      "MANUAL_RECOVERY" | "SEIZURE_EVIDENCE" | "VISIT" | "PROMISE_TO_PAY";
    purpose: string;
    requestedBy: string;
    evidence: Record<string, unknown>;
    evidenceHash: string;
    idempotencyKey: string;
    authorizedBy: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  getLocation(input: {
    recoveryCaseId: string;
    purpose: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  getCustomerStatus(
    actor: CustomerPrincipal,
  ): Promise<readonly Record<string, unknown>[]>;
}

export function createCollectionsService(options: {
  database: Database;
  tracker?: TrackerPort;
  accountLinkBaseUrl?: string;
  ussdInstructions?: string;
}): CollectionsService {
  const accountLinkBaseUrl =
    options.accountLinkBaseUrl === undefined
      ? undefined
      : validateAccountLinkBaseUrl(options.accountLinkBaseUrl);
  const ussdInstructions =
    options.ussdInstructions === undefined
      ? undefined
      : validatePaymentInstructions(options.ussdInstructions);
  return {
    async computeArrears(input) {
      requireRecoveryRole(input.actor);
      const result = await withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        if ((await repo.findContractContext(input.contractId)) === null)
          throw new AppError(
            404,
            "CONTRACT_NOT_FOUND",
            "The contract was not found.",
          );
        const arrears = computeArrears({
          asOfDate: input.asOfDate,
          installments: (
            await repo.listArrearsInstallments(input.contractId, input.asOfDate)
          ).map((item) => ({
            installmentNumber: item.installmentNumber,
            dueDate: item.dueDate,
            amountMinor: item.amountMinor,
            postedMinor: item.postedMinor,
          })),
        });
        await repo.saveArrearsSnapshot({
          contractId: input.contractId,
          asOfDate: arrears.asOfDate,
          overdueMinorUnits: arrears.overdueMinor,
          unpaidInstallments: arrears.totalUnpaid,
          consecutiveMissedInstallments: arrears.consecutiveMissed,
        });
        for (const signal of arrears.escalationSignals) {
          await repo.insertArrearsEscalation({
            contractId: input.contractId,
            asOfDate: arrears.asOfDate,
            signal,
            overdueMinorUnits: arrears.overdueMinor,
            unpaidInstallments: arrears.totalUnpaid,
            consecutiveMissedInstallments: arrears.consecutiveMissed,
          });
        }
        await appendAuditEvent(tx, {
          aggregateType: "contract",
          aggregateId: input.contractId,
          action: "ARREARS_COMPUTED",
          actorStaffUserId: input.actor.staffUserId,
          actorPersonId: null,
          requestId: input.requestId,
          data: {
            asOfDate: arrears.asOfDate,
            overdueMinorUnits: arrears.overdueMinor.toString(),
            totalUnpaid: arrears.totalUnpaid,
            consecutiveMissed: arrears.consecutiveMissed,
            escalationSignals: [...arrears.escalationSignals],
          },
          occurredAt: new Date(),
        });
        return arrears;
      });
      return { contractId: input.contractId, ...result };
    },
    async listArrears(actor) {
      requireCollectionsRead(actor);
      return withTransaction(options.database, async (tx) =>
        collectionsRepo(tx).listArrearsQueue(),
      );
    },
    async openCase(input) {
      requireRecoveryRole(input.actor);
      const purpose = requiredText(input.purpose, "RECOVERY_PURPOSE_REQUIRED");
      const reason = requiredText(input.reason, "RECOVERY_REASON_REQUIRED");
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const context = await repo.findContractContext(input.contractId);
        if (context === null)
          throw new AppError(
            404,
            "CONTRACT_NOT_FOUND",
            "The contract was not found.",
          );
        const existing = await repo.findRecoveryCaseByContract(
          input.contractId,
        );
        if (existing !== null)
          throw new AppError(
            409,
            "RECOVERY_CASE_ALREADY_OPEN",
            "An active recovery case already exists.",
          );
        const now = new Date();
        const row = await repo.insertRecoveryCase({
          id: randomUUID(),
          contractId: input.contractId,
          openedAt: now,
          ...(input.assignedOfficerId === undefined
            ? {}
            : { assignedOfficerId: input.assignedOfficerId }),
          details: {
            purpose,
            reason,
            openedByStaffUserId: input.actor.staffUserId,
            automaticAction: false,
          },
        });
        await appendAuditEvent(tx, {
          aggregateType: "recovery_case",
          aggregateId: row.id,
          action: "RECOVERY_CASE_OPENED",
          actorStaffUserId: input.actor.staffUserId,
          actorPersonId: null,
          requestId: input.requestId ?? null,
          data: {
            contractId: input.contractId,
            purpose,
            reason,
            automaticAction: false,
          },
          occurredAt: now,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "collections.recovery_case_opened",
          aggregateType: "recovery_case",
          aggregateId: row.id,
          payload: { contractId: input.contractId, recoveryCaseId: row.id },
          occurredAt: now,
        });
        return serializeCase(row);
      });
    },
    async listCases(actor) {
      requireCollectionsRead(actor);
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const cases = await repo.listRecoveryCases();
        const result: Record<string, unknown>[] = [];
        for (const row of cases) {
          const decisions = await repo.listRecoveryDecisions(row.id);
          const actions = await repo.listRecoveryActions(row.id);
          result.push({
            ...serializeCase(row),
            decisions: decisions.map(serializeDecision),
            actions: actions.map(serializeAction),
          });
        }
        return result;
      });
    },
    async decideEscalation(input) {
      requireRecoveryRole(input.checker);
      const purpose = requiredText(input.purpose, "RECOVERY_PURPOSE_REQUIRED");
      const reason = requiredText(input.reason, "RECOVERY_REASON_REQUIRED");
      validateIdempotencyKey(input.idempotencyKey);
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const existingDecision = await repo.findRecoveryDecisionByKey(
          input.idempotencyKey,
        );
        if (existingDecision !== null) {
          if (existingDecision.recoveryCaseId !== input.recoveryCaseId)
            throw new AppError(
              409,
              "RECOVERY_IDEMPOTENCY_KEY_REUSED",
              "The recovery decision idempotency key is already bound to another case.",
            );
          return serializeDecision(existingDecision);
        }
        const row = await repo.findRecoveryCase(input.recoveryCaseId, true);
        if (row === null)
          throw new AppError(
            404,
            "RECOVERY_CASE_NOT_FOUND",
            "The recovery case was not found.",
          );
        if (row.status === "CLOSED")
          throw new AppError(
            409,
            "RECOVERY_CASE_CLOSED",
            "The recovery case is closed.",
          );
        const recordedDecision = await repo.findRecoveryDecisionByCase(
          input.recoveryCaseId,
        );
        if (recordedDecision !== null)
          throw new AppError(
            409,
            "RECOVERY_DECISION_ALREADY_RECORDED",
            "This recovery case already has a final decision.",
          );
        const details = row.details as Record<string, unknown>;
        const maker = details.openedByStaffUserId;
        if (typeof maker !== "string" || maker === input.checker.staffUserId)
          throw new AppError(
            409,
            "MAKER_CANNOT_CHECK",
            "The recovery maker cannot authorize the same case.",
          );
        const now = new Date();
        const result = await repo.insertRecoveryDecision({
          id: randomUUID(),
          recoveryCaseId: input.recoveryCaseId,
          idempotencyKey: input.idempotencyKey,
          makerStaffUserId: maker,
          checkerStaffUserId: input.checker.staffUserId,
          decision: input.decision,
          purpose,
          reason,
          decidedAt: now,
        });
        if (result.row.recoveryCaseId !== input.recoveryCaseId)
          throw new AppError(
            409,
            "RECOVERY_IDEMPOTENCY_KEY_REUSED",
            "The recovery decision idempotency key is already bound to another case.",
          );
        if (result.inserted && input.decision === "APPROVED")
          await repo.updateRecoveryCase(input.recoveryCaseId, {
            status: "IN_PROGRESS",
          });
        if (result.inserted)
          await appendAuditEvent(tx, {
            aggregateType: "recovery_case",
            aggregateId: input.recoveryCaseId,
            action:
              input.decision === "APPROVED"
                ? "RECOVERY_AUTHORIZED"
                : "RECOVERY_DENIED",
            actorStaffUserId: input.checker.staffUserId,
            actorPersonId: null,
            requestId: input.requestId ?? null,
            data: {
              purpose,
              reason,
              makerStaffUserId: maker,
              decision: input.decision,
            },
            occurredAt: now,
          });
        return serializeDecision(result.row);
      });
    },
    async recordAction(input) {
      requireRecoveryRole(input.authorizedBy);
      const purpose = requiredText(input.purpose, "RECOVERY_PURPOSE_REQUIRED");
      if (
        !isUuid(input.requestedBy) ||
        input.requestedBy === input.authorizedBy.staffUserId
      )
        throw new AppError(
          409,
          "MAKER_CANNOT_CHECK",
          "The recovery action needs an independent authorizer.",
        );
      if (!/^[0-9a-f]{64}$/.test(input.evidenceHash))
        throw new AppError(
          400,
          "RECOVERY_EVIDENCE_HASH_INVALID",
          "A SHA-256 evidence hash is required.",
        );
      validateIdempotencyKey(input.idempotencyKey);
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const payloadHash = hashRecoveryActionPayload(input);
        const existing = await repo.findRecoveryActionByKey(
          input.idempotencyKey,
        );
        if (existing !== null) {
          if (
            existing.recoveryCaseId !== input.recoveryCaseId ||
            existing.payloadHash !== payloadHash
          )
            throw new AppError(
              409,
              "RECOVERY_IDEMPOTENCY_KEY_REUSED",
              "The recovery action idempotency key is already bound to another action.",
            );
          return {
            id: existing.id,
            actionType: existing.actionType,
            purpose: existing.purpose,
            authorized: true,
            replay: true,
          };
        }
        const row = await repo.findRecoveryCase(input.recoveryCaseId, true);
        if (row === null)
          throw new AppError(
            404,
            "RECOVERY_CASE_NOT_FOUND",
            "The recovery case was not found.",
          );
        if (row.status === "CLOSED")
          throw new AppError(
            409,
            "RECOVERY_CASE_CLOSED",
            "The recovery case is closed.",
          );
        const details = row.details;
        const caseMaker =
          typeof details === "object" &&
          details !== null &&
          !Array.isArray(details)
            ? (details as Record<string, unknown>).openedByStaffUserId
            : undefined;
        if (typeof caseMaker !== "string" || input.requestedBy !== caseMaker)
          throw new AppError(
            409,
            "RECOVERY_ACTION_MAKER_REQUIRED",
            "The recorded recovery action maker must be the case maker.",
          );
        const decision = await repo.findApprovedRecoveryDecision(
          input.recoveryCaseId,
        );
        if (
          decision === null ||
          decision.checkerStaffUserId !== input.authorizedBy.staffUserId
        )
          throw new AppError(
            409,
            "RECOVERY_AUTHORIZATION_REQUIRED",
            "An independent approved recovery decision is required.",
          );
        const now = new Date();
        const actionResult = await repo.insertRecoveryAction({
          id: randomUUID(),
          recoveryCaseId: input.recoveryCaseId,
          idempotencyKey: input.idempotencyKey,
          payloadHash,
          actionType: input.actionType,
          purpose,
          requestedBy: input.requestedBy,
          authorizedBy: input.authorizedBy.staffUserId,
          evidenceHash: input.evidenceHash,
          evidence: {
            ...input.evidence,
            platformCommand: false,
            deviceControl: false,
          },
          createdAt: now,
        });
        if (!actionResult.inserted) {
          if (
            actionResult.row.recoveryCaseId !== input.recoveryCaseId ||
            actionResult.row.payloadHash !== payloadHash
          )
            throw new AppError(
              409,
              "RECOVERY_IDEMPOTENCY_KEY_REUSED",
              "The recovery action idempotency key is already bound to another action.",
            );
          return {
            id: actionResult.row.id,
            actionType: actionResult.row.actionType,
            purpose: actionResult.row.purpose,
            authorized: true,
            replay: true,
          };
        }
        await appendAuditEvent(tx, {
          aggregateType: "recovery_case",
          aggregateId: input.recoveryCaseId,
          action: "RECOVERY_ACTION_RECORDED",
          actorStaffUserId: input.authorizedBy.staffUserId,
          actorPersonId: null,
          requestId: input.requestId ?? null,
          data: {
            actionId: actionResult.row.id,
            actionType: input.actionType,
            purpose,
            platformCommand: false,
          },
          occurredAt: now,
        });
        return {
          id: actionResult.row.id,
          actionType: actionResult.row.actionType,
          purpose,
          authorized: true,
          replay: false,
        };
      });
    },
    async getLocation(input) {
      requireRecoveryRole(input.actor);
      const purpose = requiredText(input.purpose, "TRACKER_PURPOSE_REQUIRED");
      if (options.tracker === undefined)
        throw new AppError(
          503,
          "TRACKER_CAPABILITY_UNAVAILABLE",
          "An attested read-only tracker capability is required.",
        );
      const context = await withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const row = await repo.findRecoveryCase(input.recoveryCaseId, true);
        if (row === null)
          throw new AppError(
            404,
            "RECOVERY_CASE_NOT_FOUND",
            "The recovery case was not found.",
          );
        if (row.status === "CLOSED")
          throw new AppError(
            409,
            "RECOVERY_CASE_CLOSED",
            "The recovery case is closed.",
          );
        if (
          (await repo.findApprovedRecoveryDecision(input.recoveryCaseId)) ===
          null
        )
          throw new AppError(
            409,
            "RECOVERY_AUTHORIZATION_REQUIRED",
            "An authorized recovery case is required.",
          );
        const tracker = await repo.findTrackerForRecoveryCase(
          input.recoveryCaseId,
        );
        if (tracker === null || tracker.tracker_id === null)
          throw new AppError(
            404,
            "TRACKER_LOCATION_UNAVAILABLE",
            "No tracker is associated with this vehicle.",
          );
        return {
          trackerId: tracker.tracker_id,
          contractId: tracker.contract_id,
        };
      });
      let location: Awaited<ReturnType<TrackerPort["getLastKnown"]>> = null;
      try {
        location = await options.tracker.getLastKnown({
          trackerId: context.trackerId,
        });
      } catch {
        location = null;
      }
      const accessedAt = new Date();
      await withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        await repo.insertRecoveryLocationLookup({
          id: randomUUID(),
          recoveryCaseId: input.recoveryCaseId,
          actorStaffUserId: input.actor.staffUserId,
          trackerId: context.trackerId,
          purpose,
          ...(location === null
            ? {}
            : {
                latitude: location.latitude,
                longitude: location.longitude,
                recordedAt: new Date(location.recordedAt),
                deviceStatus: location.deviceStatus,
              }),
          accessedAt,
        });
        await appendAuditEvent(tx, {
          aggregateType: "recovery_case",
          aggregateId: input.recoveryCaseId,
          action: "RECOVERY_LOCATION_LOOKUP",
          actorStaffUserId: input.actor.staffUserId,
          actorPersonId: null,
          requestId: input.requestId ?? null,
          data: { purpose, locationOnly: true, available: location !== null },
          occurredAt: accessedAt,
        });
      });
      if (location === null)
        throw new AppError(
          404,
          "TRACKER_LOCATION_UNAVAILABLE",
          "No last-known tracker location is available.",
        );
      return {
        contractId: context.contractId,
        latitude: location.latitude,
        longitude: location.longitude,
        recordedAt: location.recordedAt,
        accessedAt: accessedAt.toISOString(),
        locationOnly: true,
      };
    },
    async getCustomerStatus(actor) {
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const accounts = await repo.listCustomerAccounts(actor.personId);
        const result: Record<string, unknown>[] = [];
        for (const account of accounts) {
          const signals = await repo.listArrearsSignals(account.contractId);
          const paymentLink =
            accountLinkBaseUrl === undefined
              ? null
              : `${accountLinkBaseUrl}/contracts/${encodeURIComponent(account.contractId)}/status`;
          result.push({
            contractId: account.contractId,
            contractStatus: account.status,
            outstandingBalanceMinorUnits: account.outstandingBalanceMinorUnits,
            nextDueDate: account.nextDueDate,
            overdueMinorUnits: account.overdueMinorUnits,
            consecutiveMissedPayments: account.consecutiveMissedInstallments,
            totalUnpaidPayments: account.unpaidInstallments,
            signals: signals.map((signal) => signal.signal),
            cashAccepted: false,
            paymentInstructions: ussdInstructions ?? null,
            paymentLink,
          });
        }
        return result;
      });
    },
  };
}

function requireCollectionsRead(actor: StaffPrincipal): void {
  if (
    !actor.roles.some((role) =>
      [
        "RECOVERY_OFFICER",
        "BSM",
        "AGM",
        "CFO",
        "MD",
        "COMPLIANCE_AUDITOR",
        "CUSTOMER_SUPPORT",
      ].includes(role),
    )
  )
    throw new AppError(403, "FORBIDDEN", "Collections access is required.");
}

function requireRecoveryRole(actor: StaffPrincipal): void {
  if (!actor.roles.includes("RECOVERY_OFFICER"))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Recovery officer authority is required.",
    );
}

function requiredText(value: string, code: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.trim().length > 4000
  )
    throw new AppError(400, code, "A non-empty explanation is required.");
  return value.trim();
}

function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
    throw new AppError(
      400,
      "RECOVERY_IDEMPOTENCY_INVALID",
      "A valid idempotency key is required.",
    );
}

function hashRecoveryActionPayload(input: {
  recoveryCaseId: string;
  actionType: string;
  purpose: string;
  requestedBy: string;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  authorizedBy: StaffPrincipal;
}): string {
  const canonical = JSON.stringify({
    recoveryCaseId: input.recoveryCaseId,
    actionType: input.actionType,
    purpose: input.purpose,
    requestedBy: input.requestedBy,
    evidence: stableValue(input.evidence),
    evidenceHash: input.evidenceHash,
    authorizedBy: input.authorizedBy.staffUserId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableValue(entry)]),
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function validateAccountLinkBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("COLLECTIONS_ACCOUNT_LINK_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("COLLECTIONS_ACCOUNT_LINK_INVALID");
  return url.toString().replace(/\/$/, "");
}

function validatePaymentInstructions(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 240)
    throw new Error("COLLECTIONS_USSD_INSTRUCTIONS_INVALID");
  return trimmed;
}

function serializeCase(row: Record<string, unknown>): Record<string, unknown> {
  const details =
    typeof row.details === "object" &&
    row.details !== null &&
    !Array.isArray(row.details)
      ? (row.details as Record<string, unknown>)
      : {};
  return {
    id: row.id,
    contractId: row.contractId,
    status: row.status,
    details,
    purpose: typeof details.purpose === "string" ? details.purpose : undefined,
    reason: typeof details.reason === "string" ? details.reason : undefined,
    makerStaffUserId:
      typeof details.openedByStaffUserId === "string"
        ? details.openedByStaffUserId
        : undefined,
    assignedOfficerId: row.assignedOfficerId,
    openedAt:
      row.openedAt instanceof Date ? row.openedAt.toISOString() : row.openedAt,
    closedAt:
      row.closedAt instanceof Date ? row.closedAt.toISOString() : row.closedAt,
  };
}

function serializeAction(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: row.id,
    actionType: row.actionType,
    purpose: row.purpose,
    requestedBy: row.requestedBy,
    authorizedBy: row.authorizedBy,
    evidenceHash: row.evidenceHash,
    createdAt:
      row.createdAt instanceof Date
        ? row.createdAt.toISOString()
        : row.createdAt,
  };
}

function serializeDecision(
  row: Record<string, unknown>,
): Record<string, unknown> {
  return {
    id: row.id,
    recoveryCaseId: row.recoveryCaseId,
    decision: row.decision,
    purpose: row.purpose,
    reason: row.reason,
    makerStaffUserId: row.makerStaffUserId,
    checkerStaffUserId: row.checkerStaffUserId,
    decidedAt:
      row.decidedAt instanceof Date
        ? row.decidedAt.toISOString()
        : row.decidedAt,
  };
}
