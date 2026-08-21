import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  paymentRepo,
  withTransaction,
  type Database,
  type DatabaseTransaction,
  type PaymentAllocationPolicy,
  type PaymentTransaction,
} from "@somo/db";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";
import type { ReceiptService } from "./receipt-service.js";

export interface AllocationDecision {
  outcome: "MATCHED" | "QUARANTINED";
  allocations: readonly {
    installmentId: string;
    amountMinorUnits: bigint;
  }[];
  reason?: string;
}

export interface AllocationPolicy {
  readonly version: string;
  /** Package-owned executable policy representation; callers cannot inject behavior. */
  readonly executionKey: typeof ALLOCATION_POLICY_EXECUTION_KEY;
  readonly policyHash: string;
  readonly workedExampleHash: string;
  readonly financeApprovedBy: string;
  readonly complianceApprovedBy: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
}

export const ALLOCATION_POLICY_VERSION = "finance-policy-v1" as const;
export const ALLOCATION_POLICY_EXECUTION_KEY =
  "SOMOCO_DEPOSIT_OR_INSTALLMENT_V1" as const;

export const allocationPolicyWorkedExample = Object.freeze({
  version: ALLOCATION_POLICY_VERSION,
  executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
  rules: Object.freeze([
    "match an exact contract deposit",
    "match one exact remaining installment",
    "quarantine all other amounts for Finance reconciliation",
  ]),
});

const allocationPolicyRepresentation = Object.freeze({
  version: ALLOCATION_POLICY_VERSION,
  executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
  behavior: "package-owned",
});

export const ALLOCATION_POLICY_WORKED_EXAMPLE_HASH = sha256(
  canonicalJson(allocationPolicyWorkedExample),
);
export const ALLOCATION_POLICY_HASH = sha256(
  canonicalJson(allocationPolicyRepresentation),
);

export function createAllocationPolicyApproval(input: {
  financeApprovedBy: string;
  complianceApprovedBy: string;
  approvedAt: string;
}): AllocationPolicy {
  return Object.freeze({
    version: ALLOCATION_POLICY_VERSION,
    executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
    policyHash: ALLOCATION_POLICY_HASH,
    workedExampleHash: ALLOCATION_POLICY_WORKED_EXAMPLE_HASH,
    financeApprovedBy: input.financeApprovedBy,
    complianceApprovedBy: input.complianceApprovedBy,
    approvedBy: input.financeApprovedBy,
    approvedAt: input.approvedAt,
  });
}

export interface LedgerPostInput {
  contractReference: string;
  providerTransactionId: string;
  eventId: string;
  eventType?: "PAYMENT_SUCCEEDED" | "PAYMENT_REVERSED" | "PAYMENT_REFUNDED";
  payerReference?: string;
  amountMinorUnits: bigint;
  currency: "GHS";
  occurredAt: Date;
  settlementReference?: string;
  policy?: AllocationPolicy;
  providerPayload?: Record<string, unknown>;
  /** Internal transaction capability used by the webhook inbox transaction. */
  transaction?: DatabaseTransaction;
}

export interface LedgerPostResult {
  paymentTransaction: PaymentTransaction;
  outcome: "POSTED" | "QUARANTINED" | "REVERSED" | "REFUNDED";
  ledgerEntryIds: readonly string[];
  receiptId?: string;
  depositReconciled: boolean;
  reason?: string;
}

export interface LedgerService {
  post(input: LedgerPostInput): Promise<LedgerPostResult>;
  reverse(input: {
    originalProviderTransactionId: string;
    eventId: string;
    eventType: "PAYMENT_REVERSED" | "PAYMENT_REFUNDED";
    occurredAt: Date;
    settlementReference?: string;
    transaction?: DatabaseTransaction;
  }): Promise<LedgerPostResult>;
  requestAdjustment(input: {
    contractId: string;
    amountMinorUnits: bigint;
    direction: "DEBIT" | "CREDIT";
    reason: string;
    maker: StaffPrincipal;
    idempotencyKey: string;
  }): Promise<{ id: string; status: "PENDING" }>;
  approveAdjustment(input: {
    adjustmentId: string;
    checker: StaffPrincipal;
    decision: "APPROVE" | "REJECT";
    reason: string;
  }): Promise<{ id: string; status: "APPROVED" | "REJECTED" }>;
}

export function createLedgerService(options: {
  database: Database;
  receipts?: ReceiptService;
}): LedgerService {
  return {
    async post(input) {
      if (input.policy !== undefined) validatePolicy(input.policy);
      if (input.amountMinorUnits <= 0n) {
        throw new AppError(
          400,
          "PAYMENT_AMOUNT_INVALID",
          "Payment amount must be positive.",
        );
      }
      const operation = async (
        tx: DatabaseTransaction,
      ): Promise<LedgerPostResult> => {
        const repo = paymentRepo(tx);
        const duplicate = await repo.findByProviderTransaction(
          "SOMOCO_PAYMENTS",
          input.providerTransactionId,
        );
        if (duplicate !== null) return duplicateResult(repo, duplicate);
        if (input.policy === undefined)
          throw new AppError(
            409,
            "ALLOCATION_POLICY_REQUIRED",
            "Finance must approve a payment allocation policy before posting.",
          );
        const approvedPolicy = await repo.findApprovedAllocationPolicy(
          input.policy.version,
        );
        if (!isPersistedPolicyApproved(approvedPolicy, input.policy))
          throw new AppError(
            409,
            "ALLOCATION_POLICY_NOT_APPROVED",
            "The persisted Finance and Compliance allocation policy approval is required.",
          );
        const context = await repo.findContractByReference(
          input.contractReference,
        );
        const paymentId = randomUUID();
        const insertedPayment = await repo.insertIfAbsent(
          {
            id: paymentId,
            provider: "SOMOCO_PAYMENTS",
            channel: inferChannel(input.providerPayload),
            providerTransactionId: input.providerTransactionId,
            eventId: input.eventId,
            eventType: input.eventType ?? "PAYMENT_SUCCEEDED",
            ...(input.settlementReference === undefined
              ? {}
              : { settlementReference: input.settlementReference }),
            ...(context === null ? {} : { contractId: context.contractId }),
            payerReference: input.payerReference ?? input.contractReference,
            currency: input.currency,
            amountMinorUnits: input.amountMinorUnits,
            status: "RECEIVED",
            providerPayload: input.providerPayload ?? {},
            occurredAt: input.occurredAt,
          },
          {
            audit: {
              aggregateType: "payment_transaction",
              aggregateId: paymentId,
              action: "PAYMENT_RECEIVED",
              actorStaffUserId: null,
              actorPersonId: null,
              requestId: null,
              data: {
                eventId: input.eventId,
                providerTransactionId: input.providerTransactionId,
              },
              occurredAt: input.occurredAt,
            },
            outbox: {
              id: randomUUID(),
              topic: "payments.payment_received",
              aggregateType: "payment_transaction",
              aggregateId: paymentId,
              payload: {
                paymentTransactionId: paymentId,
                eventId: input.eventId,
              },
              occurredAt: input.occurredAt,
            },
          },
        );
        if (!insertedPayment.inserted)
          return duplicateResult(repo, insertedPayment.payment);
        const payment = insertedPayment.payment;
        if (context === null) {
          await repo.createReconciliationCase({
            paymentTransactionId: payment.id,
            reason: "UNMATCHED_CUSTOMER_REFERENCE",
          });
          return {
            paymentTransaction: payment,
            outcome: "QUARANTINED",
            ledgerEntryIds: [],
            depositReconciled: false,
            reason: "UNMATCHED_CUSTOMER_REFERENCE",
          };
        }
        const installments = await repo.listInstallments(context.contractId);
        const decision = decideAllocationPolicy({
          amountMinorUnits: input.amountMinorUnits,
          depositMinorUnits: context.depositMinorUnits,
          installments,
        });
        if (
          decision.outcome !== "MATCHED" ||
          decision.allocations.length === 0
        ) {
          const reason = decision.reason ?? "PAYMENT_REQUIRES_RECONCILIATION";
          await repo.createReconciliationCase({
            paymentTransactionId: payment.id,
            reason,
          });
          return {
            paymentTransaction: payment,
            outcome: "QUARANTINED",
            ledgerEntryIds: [],
            depositReconciled: false,
            reason,
          };
        }
        const allocated = decision.allocations.reduce(
          (sum, allocation) => sum + allocation.amountMinorUnits,
          0n,
        );
        if (allocated !== input.amountMinorUnits) {
          const reason = "ALLOCATION_TOTAL_MISMATCH";
          await repo.createReconciliationCase({
            paymentTransactionId: payment.id,
            reason,
          });
          return {
            paymentTransaction: payment,
            outcome: "QUARANTINED",
            ledgerEntryIds: [],
            depositReconciled: false,
            reason,
          };
        }
        const entryIds: string[] = [];
        let balanceAfter: bigint;
        for (const allocation of decision.allocations) {
          const aggregate = await repo.updatePaymentAggregates({
            contractId: context.contractId,
            installmentId: allocation.installmentId,
            paymentMinorUnits: allocation.amountMinorUnits,
          });
          balanceAfter = aggregate.balanceAfterMinorUnits;
          const entry = await repo.appendLedger({
            id: randomUUID(),
            postingKey: `${input.providerTransactionId}:${allocation.installmentId}:PAYMENT_SUCCEEDED`,
            contractId: context.contractId,
            paymentTransactionId: payment.id,
            installmentId: allocation.installmentId,
            entryType:
              context.depositMinorUnits === input.amountMinorUnits
                ? "DEPOSIT"
                : "REPAYMENT",
            direction: "CREDIT",
            currency: input.currency,
            amountMinorUnits: allocation.amountMinorUnits,
            balanceAfterMinorUnits: balanceAfter,
            allocationPolicyVersion: input.policy!.version,
            metadata: {
              policyVersion: input.policy!.version,
              policyApprovedBy: input.policy!.approvedBy,
              policyApprovedAt: input.policy!.approvedAt,
            },
            occurredAt: input.occurredAt,
          });
          entryIds.push(entry.id);
        }
        const posted = await repo.updateStatus(payment.id, "POSTED");
        const receipt =
          options.receipts === undefined
            ? await issueReceipt(repo, posted, input.occurredAt)
            : await options.receipts.issue({
                payment: posted,
                now: input.occurredAt,
                transaction: tx,
              });
        const depositReconciled =
          context.depositMinorUnits === input.amountMinorUnits;
        if (depositReconciled)
          await repo.reconcileDeposit({
            applicationId: context.applicationId,
            offerId: context.offerId,
            paymentTransactionId: payment.id,
            amountMinorUnits: input.amountMinorUnits,
            evidenceHash: sha256(input.eventId),
          });
        await appendAuditEvent(tx, {
          aggregateType: "payment_transaction",
          aggregateId: payment.id,
          action: "PAYMENT_POSTED",
          actorStaffUserId: null,
          actorPersonId: context.payerPersonId,
          requestId: null,
          data: {
            entryIds,
            receiptId: receipt.id,
            policyVersion: input.policy!.version,
          },
          occurredAt: input.occurredAt,
        });
        return {
          paymentTransaction: posted,
          outcome: "POSTED",
          ledgerEntryIds: entryIds,
          receiptId: receipt.id,
          depositReconciled,
        };
      };
      return input.transaction === undefined
        ? withTransaction(options.database, operation)
        : operation(input.transaction);
    },
    async reverse(input) {
      const operation = async (
        tx: DatabaseTransaction,
      ): Promise<LedgerPostResult> => {
        const repo = paymentRepo(tx);
        const original = await repo.findByProviderTransaction(
          "SOMOCO_PAYMENTS",
          input.originalProviderTransactionId,
        );
        if (original === null)
          throw new AppError(
            409,
            "ORIGINAL_PAYMENT_NOT_FOUND",
            "The original payment is not available for reversal.",
          );
        const existing = await repo.findByEventId(
          "SOMOCO_PAYMENTS",
          input.eventId,
        );
        if (existing !== null)
          return {
            paymentTransaction: existing,
            outcome:
              input.eventType === "PAYMENT_REFUNDED" ? "REFUNDED" : "REVERSED",
            ledgerEntryIds: (await repo.findLedgerForPayment(existing.id)).map(
              (entry) => entry.id,
            ),
            depositReconciled: false,
          };
        const payment = await repo.insert(
          {
            id: randomUUID(),
            provider: "SOMOCO_PAYMENTS",
            channel: original.channel,
            providerTransactionId: `${original.providerTransactionId}:${input.eventType}`,
            eventId: input.eventId,
            eventType: input.eventType,
            ...(original.contractId === null
              ? {}
              : { contractId: original.contractId }),
            ...(input.settlementReference === undefined
              ? {}
              : { settlementReference: input.settlementReference }),
            payerReference: original.payerReference,
            currency: original.currency,
            amountMinorUnits: original.amountMinorUnits,
            status: "RECEIVED",
            providerPayload: {
              originalProviderTransactionId: original.providerTransactionId,
            },
            occurredAt: input.occurredAt,
          },
          {
            audit: {
              aggregateType: "payment_transaction",
              aggregateId: original.id,
              action: input.eventType,
              actorStaffUserId: null,
              actorPersonId: null,
              requestId: null,
              data: { eventId: input.eventId },
              occurredAt: input.occurredAt,
            },
            outbox: {
              id: randomUUID(),
              topic: "payments.payment_reversed",
              aggregateType: "payment_transaction",
              aggregateId: original.id,
              payload: {
                originalPaymentTransactionId: original.id,
                eventId: input.eventId,
              },
              occurredAt: input.occurredAt,
            },
          },
        );
        const originals = await repo.findLedgerForPayment(original.id);
        const entryIds: string[] = [];
        for (const entry of originals) {
          if (entry.installmentId === null)
            throw new AppError(
              409,
              "REVERSAL_INSTALLMENT_REQUIRED",
              "A payment posting without an installment cannot be reversed automatically.",
            );
          const aggregate = await repo.reversePaymentAggregates({
            contractId: entry.contractId,
            installmentId: entry.installmentId,
            paymentMinorUnits: entry.amountMinorUnits,
          });
          const compensation = await repo.appendLedger({
            id: randomUUID(),
            postingKey: `${input.eventId}:${entry.id}:COMPENSATION`,
            contractId: entry.contractId,
            paymentTransactionId: payment.id,
            installmentId: entry.installmentId,
            entryType:
              input.eventType === "PAYMENT_REFUNDED" ? "REFUND" : "REVERSAL",
            direction: "DEBIT",
            currency: entry.currency,
            amountMinorUnits: entry.amountMinorUnits,
            balanceAfterMinorUnits: aggregate.balanceAfterMinorUnits,
            reversesEntryId: entry.id,
            allocationPolicyVersion: entry.allocationPolicyVersion,
            metadata: { reversesEntryId: entry.id },
            occurredAt: input.occurredAt,
          });
          entryIds.push(compensation.id);
        }
        await repo.updateStatus(
          original.id,
          input.eventType === "PAYMENT_REFUNDED" ? "REFUNDED" : "REVERSED",
        );
        await repo.invalidateDeposit({
          paymentTransactionId: original.id,
          reason: sha256(`${input.eventId}:deposit-invalidated`),
        });
        const updated = await repo.updateStatus(
          payment.id,
          input.eventType === "PAYMENT_REFUNDED" ? "REFUNDED" : "REVERSED",
        );
        return {
          paymentTransaction: updated,
          outcome:
            input.eventType === "PAYMENT_REFUNDED" ? "REFUNDED" : "REVERSED",
          ledgerEntryIds: entryIds,
          depositReconciled: false,
        };
      };
      return input.transaction === undefined
        ? withTransaction(options.database, operation)
        : operation(input.transaction);
    },
    async requestAdjustment(input) {
      if (!input.maker.roles.includes("FINANCE_OFFICER"))
        throw new AppError(
          403,
          "FORBIDDEN",
          "Finance adjustment authority is required.",
        );
      const created = await withTransaction(options.database, async (tx) => {
        const adjustment = await paymentRepo(tx).createAdjustment({
          id: randomUUID(),
          contractId: input.contractId,
          makerStaffUserId: input.maker.staffUserId,
          amountMinorUnits: input.amountMinorUnits,
          direction: input.direction,
          reason: input.reason,
          status: "PENDING",
          idempotencyKey: input.idempotencyKey,
        });
        await appendAuditEvent(tx, {
          aggregateType: "payment_adjustment",
          aggregateId: adjustment.id,
          action: "PAYMENT_ADJUSTMENT_REQUESTED",
          actorStaffUserId: input.maker.staffUserId,
          actorPersonId: null,
          requestId: null,
          data: {
            amountMinorUnits: input.amountMinorUnits.toString(),
            direction: input.direction,
            reason: input.reason,
          },
          occurredAt: new Date(),
        });
        return adjustment;
      });
      return { id: created.id, status: "PENDING" };
    },
    async approveAdjustment(input) {
      if (
        !input.checker.roles.includes("CFO") &&
        !input.checker.roles.includes("COMPLIANCE_AUDITOR")
      )
        throw new AppError(
          403,
          "FORBIDDEN",
          "An independent finance checker is required.",
        );
      const result = await withTransaction(options.database, async (tx) => {
        const repo = paymentRepo(tx);
        const adjustment = await repo.findAdjustment(input.adjustmentId);
        if (adjustment === null)
          throw new AppError(
            404,
            "ADJUSTMENT_NOT_FOUND",
            "Payment adjustment not found.",
          );
        if (adjustment.makerStaffUserId === input.checker.staffUserId)
          throw new AppError(
            409,
            "MAKER_CANNOT_CHECK",
            "The adjustment maker cannot approve the same adjustment.",
          );
        if (input.decision === "APPROVE") {
          const aggregate = await repo.adjustContractBalance({
            contractId: adjustment.contractId,
            amountMinorUnits: adjustment.amountMinorUnits,
            direction: adjustment.direction,
          });
          const entry = await repo.appendLedger({
            id: randomUUID(),
            postingKey: `ADJUSTMENT:${adjustment.id}`,
            contractId: adjustment.contractId,
            entryType: "ADJUSTMENT",
            direction: adjustment.direction,
            currency: "GHS",
            amountMinorUnits: adjustment.amountMinorUnits,
            balanceAfterMinorUnits: aggregate.balanceAfterMinorUnits,
            metadata: {
              adjustmentId: adjustment.id,
              reason: adjustment.reason,
            },
            occurredAt: new Date(),
          });
          const decided = await repo.decideAdjustment({
            id: adjustment.id,
            checkerStaffUserId: input.checker.staffUserId,
            status: "APPROVED",
            decisionReason: input.reason,
            ledgerEntryId: entry.id,
          });
          await appendAuditEvent(tx, {
            aggregateType: "ledger_entry",
            aggregateId: entry.id,
            action: "PAYMENT_ADJUSTMENT_POSTED",
            actorStaffUserId: input.checker.staffUserId,
            actorPersonId: null,
            requestId: null,
            data: {
              adjustmentId: adjustment.id,
              amountMinorUnits: adjustment.amountMinorUnits.toString(),
              direction: adjustment.direction,
            },
            occurredAt: new Date(),
          });
          await appendAuditEvent(tx, {
            aggregateType: "payment_adjustment",
            aggregateId: decided.id,
            action: "PAYMENT_ADJUSTMENT_APPROVED",
            actorStaffUserId: input.checker.staffUserId,
            actorPersonId: null,
            requestId: null,
            data: { reason: input.reason, ledgerEntryId: entry.id },
            occurredAt: new Date(),
          });
          return decided;
        }
        const decided = await repo.decideAdjustment({
          id: adjustment.id,
          checkerStaffUserId: input.checker.staffUserId,
          status: "REJECTED",
          decisionReason: input.reason,
        });
        await appendAuditEvent(tx, {
          aggregateType: "payment_adjustment",
          aggregateId: decided.id,
          action: "PAYMENT_ADJUSTMENT_REJECTED",
          actorStaffUserId: input.checker.staffUserId,
          actorPersonId: null,
          requestId: null,
          data: { reason: input.reason },
          occurredAt: new Date(),
        });
        return decided;
      });
      return {
        id: result.id,
        status: result.status as "APPROVED" | "REJECTED",
      };
    },
  };
}

function validatePolicy(policy: AllocationPolicy): void {
  const legacyBehavior = (policy as unknown as { decide?: unknown }).decide;
  if (
    policy.version !== ALLOCATION_POLICY_VERSION ||
    policy.executionKey !== ALLOCATION_POLICY_EXECUTION_KEY ||
    policy.policyHash !== ALLOCATION_POLICY_HASH ||
    policy.workedExampleHash !== ALLOCATION_POLICY_WORKED_EXAMPLE_HASH ||
    policy.financeApprovedBy.trim().length === 0 ||
    policy.complianceApprovedBy.trim().length === 0 ||
    policy.financeApprovedBy === policy.complianceApprovedBy ||
    policy.approvedBy !== policy.financeApprovedBy ||
    !Number.isFinite(Date.parse(policy.approvedAt)) ||
    typeof legacyBehavior === "function"
  )
    throw new AppError(
      409,
      "ALLOCATION_POLICY_INVALID",
      "The allocation policy approval evidence is invalid.",
    );
}

function isPersistedPolicyApproved(
  approved: PaymentAllocationPolicy | null,
  input: AllocationPolicy,
): approved is PaymentAllocationPolicy {
  if (approved === null) return false;
  if (
    approved.version !== input.version ||
    approved.policyHash !== input.policyHash ||
    approved.policyHash !== ALLOCATION_POLICY_HASH ||
    approved.workedExampleHash !== input.workedExampleHash ||
    approved.workedExampleHash !== ALLOCATION_POLICY_WORKED_EXAMPLE_HASH ||
    approved.financeApprovedBy !== input.financeApprovedBy ||
    approved.complianceApprovedBy !== input.complianceApprovedBy ||
    approved.approvedAt.toISOString() !== input.approvedAt
  )
    return false;
  const canonicalWorkedExample = canonicalJson(approved.workedExample);
  return (
    sha256(canonicalWorkedExample) === approved.workedExampleHash &&
    canonicalWorkedExample === canonicalJson(allocationPolicyWorkedExample)
  );
}

async function duplicateResult(
  repo: ReturnType<typeof paymentRepo>,
  duplicate: PaymentTransaction,
): Promise<LedgerPostResult> {
  const duplicateLedger = await repo.findLedgerForPayment(duplicate.id);
  const receipt = await repo.findReceipt(duplicate.id);
  return {
    paymentTransaction: duplicate,
    outcome:
      duplicate.status === "REVERSED"
        ? "REVERSED"
        : duplicate.status === "REFUNDED"
          ? "REFUNDED"
          : duplicateLedger.length > 0
            ? "POSTED"
            : "QUARANTINED",
    ledgerEntryIds: duplicateLedger.map((entry) => entry.id),
    ...(receipt === null ? {} : { receiptId: receipt.id }),
    depositReconciled: false,
    reason: "DUPLICATE_PROVIDER_TRANSACTION",
  };
}

function decideAllocationPolicy(input: {
  amountMinorUnits: bigint;
  depositMinorUnits: bigint;
  installments: readonly {
    id: string;
    amountMinorUnits: bigint;
    paidMinorUnits: bigint;
  }[];
}): AllocationDecision {
  const installment = input.installments.find(
    (candidate) => candidate.paidMinorUnits < candidate.amountMinorUnits,
  );
  if (installment === undefined)
    return {
      outcome: "QUARANTINED",
      allocations: [],
      reason: "AMOUNT_REQUIRES_RECONCILIATION",
    };
  const remaining = installment.amountMinorUnits - installment.paidMinorUnits;
  if (
    input.amountMinorUnits !== input.depositMinorUnits &&
    input.amountMinorUnits !== remaining
  )
    return {
      outcome: "QUARANTINED",
      allocations: [],
      reason: "AMOUNT_REQUIRES_RECONCILIATION",
    };
  if (input.amountMinorUnits > remaining)
    return {
      outcome: "QUARANTINED",
      allocations: [],
      reason: "AMOUNT_REQUIRES_RECONCILIATION",
    };
  return {
    outcome: "MATCHED",
    allocations: [
      {
        installmentId: installment.id,
        amountMinorUnits: input.amountMinorUnits,
      },
    ],
  };
}

function inferChannel(
  payload: Record<string, unknown> | undefined,
): "USSD" | "MOBILE_MONEY" {
  if (payload?.channel === "USSD" || payload?.channel === "MOBILE_MONEY")
    return payload.channel;
  throw new AppError(
    400,
    "PAYMENT_CHANNEL_REQUIRED",
    "The payment channel must be explicitly USSD or Mobile Money.",
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

async function issueReceipt(
  repo: ReturnType<typeof paymentRepo>,
  payment: PaymentTransaction,
  now: Date,
) {
  const existing = await repo.findReceipt(payment.id);
  if (existing !== null) return existing;
  const receiptId = randomUUID();
  return repo.issueReceipt({
    id: receiptId,
    paymentTransactionId: payment.id,
    ...(payment.contractId === null ? {} : { contractId: payment.contractId }),
    receiptNumber: `SOMO-${payment.id.slice(0, 12).toUpperCase()}`,
    payerReference: payment.payerReference,
    amountMinorUnits: payment.amountMinorUnits,
    currency: payment.currency,
    issuedAt: now,
    securePath: `/account/receipts/${receiptId}`,
  });
}
