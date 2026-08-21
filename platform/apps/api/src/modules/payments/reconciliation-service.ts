import {
  appendAuditEvent,
  paymentRepo,
  withTransaction,
  type Database,
} from "@somo/db";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface SettlementComparison {
  id: string;
  settlementReference: string;
  providerTotalMinorUnits: string;
  ledgerTotalMinorUnits: string;
  varianceMinorUnits: string;
  status: "MATCHED" | "VARIANCE";
  reconciliationCaseId: string | null;
}

export interface ReconciliationService {
  compareSettlement(input: {
    settlementReference: string;
    providerTotalMinorUnits: bigint;
    provider: "SOMOCO_PAYMENTS";
    actor: StaffPrincipal;
    receivedAt?: Date;
  }): Promise<SettlementComparison>;
  listInbox(): Promise<readonly Record<string, unknown>[]>;
  listCases(): Promise<readonly Record<string, unknown>[]>;
  listSettlements(): Promise<readonly Record<string, unknown>[]>;
  listAdjustments(): Promise<readonly Record<string, unknown>[]>;
  resolveCase(input: {
    caseId: string;
    actor: StaffPrincipal;
    resolution: Record<string, unknown>;
  }): Promise<void>;
}

export function createReconciliationService(options: {
  database: Database;
}): ReconciliationService {
  return {
    async compareSettlement(input) {
      if (
        input.actor.kind !== "staff" ||
        (!input.actor.roles.includes("FINANCE_OFFICER") &&
          !input.actor.roles.includes("CFO") &&
          !input.actor.roles.includes("COMPLIANCE_AUDITOR"))
      )
        throw new AppError(
          403,
          "FORBIDDEN",
          "Finance reconciliation authority is required.",
        );
      if (input.providerTotalMinorUnits < 0n)
        throw new AppError(
          400,
          "SETTLEMENT_TOTAL_INVALID",
          "Settlement total cannot be negative.",
        );
      if (input.settlementReference.trim().length === 0)
        throw new AppError(
          400,
          "SETTLEMENT_REFERENCE_INVALID",
          "Settlement reference is required.",
        );
      return withTransaction(options.database, async (tx) => {
        const repo = paymentRepo(tx);
        const existing = await repo.findSettlementBatch(
          input.provider,
          input.settlementReference,
        );
        if (existing !== null)
          return {
            id: existing.id,
            settlementReference: existing.settlementReference,
            providerTotalMinorUnits: String(existing.providerTotalMinorUnits),
            ledgerTotalMinorUnits: String(existing.ledgerTotalMinorUnits),
            varianceMinorUnits: String(existing.varianceMinorUnits),
            status: existing.status as "MATCHED" | "VARIANCE",
            reconciliationCaseId: existing.reconciliationCaseId,
          };
        const ledgerTotal = await repo.sumLedgerForSettlement(
          input.settlementReference,
        );
        const variance = input.providerTotalMinorUnits - ledgerTotal;
        const status = variance === 0n ? "MATCHED" : "VARIANCE";
        const reconciliationCase =
          variance === 0n
            ? undefined
            : await repo.createReconciliationCase({
                dedupeKey: `SETTLEMENT_VARIANCE:${input.provider}:${input.settlementReference}`,
                reason: "SETTLEMENT_VARIANCE",
                resolution: {
                  settlementReference: input.settlementReference,
                  providerTotalMinorUnits:
                    input.providerTotalMinorUnits.toString(),
                  ledgerTotalMinorUnits: ledgerTotal.toString(),
                },
              });
        const batch = await repo.insertSettlementBatch({
          provider: input.provider,
          settlementReference: input.settlementReference,
          settlementCurrency: "GHS",
          providerTotalMinorUnits: input.providerTotalMinorUnits,
          ledgerTotalMinorUnits: ledgerTotal,
          varianceMinorUnits: variance,
          status,
          ...(reconciliationCase === undefined
            ? {}
            : { reconciliationCaseId: reconciliationCase.id }),
          receivedAt: input.receivedAt ?? new Date(),
          reconciledAt: status === "MATCHED" ? new Date() : undefined,
        });
        await appendAuditEvent(tx, {
          aggregateType: "payment_settlement_batch",
          aggregateId: batch.id,
          action:
            status === "MATCHED"
              ? "PAYMENT_SETTLEMENT_MATCHED"
              : "PAYMENT_SETTLEMENT_VARIANCE",
          actorStaffUserId: input.actor.staffUserId,
          actorPersonId: null,
          requestId: null,
          data: {
            settlementReference: input.settlementReference,
            providerTotalMinorUnits: input.providerTotalMinorUnits.toString(),
            ledgerTotalMinorUnits: ledgerTotal.toString(),
            varianceMinorUnits: variance.toString(),
          },
          occurredAt: input.receivedAt ?? new Date(),
        });
        return {
          id: batch.id,
          settlementReference: batch.settlementReference,
          providerTotalMinorUnits: input.providerTotalMinorUnits.toString(),
          ledgerTotalMinorUnits: ledgerTotal.toString(),
          varianceMinorUnits: variance.toString(),
          status,
          reconciliationCaseId: reconciliationCase?.id ?? null,
        };
      });
    },
    async listCases() {
      return withTransaction(options.database, async (tx) =>
        paymentRepo(tx).listReconciliationCases(),
      );
    },
    async listInbox() {
      return withTransaction(options.database, async (tx) =>
        paymentRepo(tx).listFinanceInbox(),
      );
    },
    async listSettlements() {
      return withTransaction(options.database, async (tx) =>
        paymentRepo(tx).listSettlementBatches(),
      );
    },
    async listAdjustments() {
      return withTransaction(options.database, async (tx) =>
        paymentRepo(tx).listAdjustments(),
      );
    },
    async resolveCase(input) {
      if (
        !input.actor.roles.includes("FINANCE_OFFICER") &&
        !input.actor.roles.includes("CFO") &&
        !input.actor.roles.includes("COMPLIANCE_AUDITOR")
      )
        throw new AppError(
          403,
          "FORBIDDEN",
          "Finance reconciliation authority is required.",
        );
      await withTransaction(options.database, async (tx) => {
        const repo = paymentRepo(tx);
        await repo.resolveReconciliationCase(
          input.caseId,
          input.actor.staffUserId,
          input.resolution,
        );
        await appendAuditEvent(tx, {
          aggregateType: "reconciliation_case",
          aggregateId: input.caseId,
          action: "RECONCILIATION_CASE_RESOLVED",
          actorStaffUserId: input.actor.staffUserId,
          actorPersonId: null,
          requestId: null,
          data: input.resolution,
          occurredAt: new Date(),
        });
      });
    },
  };
}
