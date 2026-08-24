import { createHash, randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  enqueueOutbox,
  paymentRepo,
  withTransaction,
  type Database,
  type DatabaseTransaction,
  type PaymentAllocationPolicy,
  type PaymentTransaction,
} from "@somo/db";
import type { AllocationPolicyEvidenceVerificationInput } from "@somo/integrations";
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

export interface AllocationPolicyEvidence {
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly evidenceHash: string;
  readonly financeApprovedBy: string;
  readonly complianceApprovedBy: string;
  readonly financeSignature: string;
  readonly complianceSignature: string;
  readonly financeApprovedAt: string;
  readonly complianceApprovedAt: string;
}

export interface AllocationPolicy {
  readonly version: string;
  /** Package-owned executable policy identity; callers cannot inject behavior. */
  readonly executionKey: typeof ALLOCATION_POLICY_EXECUTION_KEY;
  readonly behaviorDigest: string;
  readonly evidence: AllocationPolicyEvidence;
}

export const ALLOCATION_POLICY_VERSION = "finance-policy-v1" as const;
export const ALLOCATION_POLICY_EXECUTION_KEY =
  "SOMOCO_DEPOSIT_OR_INSTALLMENT_V1" as const;
export const ALLOCATION_POLICY_EVIDENCE_SCHEMA =
  "SOMOCO_ALLOCATION_POLICY_EVIDENCE_V1" as const;

const allocationPolicyImplementation = Object.freeze({
  version: ALLOCATION_POLICY_VERSION,
  executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
  algorithm: "EXACT_DEPOSIT_OR_REMAINING_INSTALLMENT",
  revision: 1,
  unmatchedOutcome: "QUARANTINED",
});

/** Immutable package behavior identity used to bind persisted approvals. */
export const ALLOCATION_POLICY_BEHAVIOR_DIGEST = sha256(
  canonicalJson({
    ...allocationPolicyImplementation,
    runtimeSource: decideAllocationPolicy.toString(),
  }),
);

/** Hashes the canonical artifact supplied by Finance and Compliance. */
export function hashAllocationEvidenceArtifact(
  artifact: Readonly<Record<string, unknown>>,
): string {
  return sha256(canonicalJson(artifact));
}

/**
 * Builds the detached-signature document for the trusted external verifier.
 * Signed bytes are derived from the exact policy identity and evidence that
 * will be persisted; callers cannot provide an alternate byte representation.
 */
export function createAllocationPolicyEvidenceVerificationInput(
  policy: AllocationPolicy,
): AllocationPolicyEvidenceVerificationInput {
  const evidence = policy.evidence;
  const signedDocument = canonicalJson({
    schema: ALLOCATION_POLICY_EVIDENCE_SCHEMA,
    artifactHash: evidence.evidenceHash,
    financeApprovedBy: evidence.financeApprovedBy,
    complianceApprovedBy: evidence.complianceApprovedBy,
    financeApprovedAt: evidence.financeApprovedAt,
    complianceApprovedAt: evidence.complianceApprovedAt,
    policyVersion: policy.version,
    executionKey: policy.executionKey,
    allocationEngineDigest: policy.behaviorDigest,
  });
  return {
    signedBytes: new TextEncoder().encode(signedDocument),
    evidence: {
      artifactHash: evidence.evidenceHash,
      financeApprovedBy: evidence.financeApprovedBy,
      complianceApprovedBy: evidence.complianceApprovedBy,
      financeSignature: evidence.financeSignature,
      complianceSignature: evidence.complianceSignature,
      financeApprovedAt: evidence.financeApprovedAt,
      complianceApprovedAt: evidence.complianceApprovedAt,
      policyVersion: policy.version,
      executionKey: policy.executionKey,
      allocationEngineDigest: policy.behaviorDigest,
    },
  };
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
  /** Evidence attestation returned by the trusted external verifier. */
  policyAttestationReference?: string;
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
  findDuplicateProviderTransaction(input: {
    providerTransactionId: string;
    transaction?: DatabaseTransaction;
  }): Promise<LedgerPostResult | null>;
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
  }): Promise<{
    id: string;
    status: "APPROVED" | "REJECTED" | "QUARANTINED";
  }>;
}

export function createLedgerService(options: {
  database: Database;
  receipts?: ReceiptService;
}): LedgerService {
  return {
    async findDuplicateProviderTransaction(input) {
      const operation = async (
        tx: DatabaseTransaction,
      ): Promise<LedgerPostResult | null> => {
        const repo = paymentRepo(tx);
        const duplicate = await repo.findByProviderTransaction(
          "SOMOCO_PAYMENTS",
          input.providerTransactionId,
        );
        return duplicate === null ? null : duplicateResult(repo, duplicate);
      };
      return input.transaction === undefined
        ? withTransaction(options.database, operation)
        : operation(input.transaction);
    },
    async post(input) {
      if (input.policy !== undefined) validateAllocationPolicy(input.policy);
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
        const preContractDeposit =
          context === null
            ? await repo.findPreContractDepositByReference(
                input.contractReference,
              )
            : null;
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
          if (preContractDeposit !== null) {
            if (
              input.amountMinorUnits !== preContractDeposit.depositMinorUnits
            ) {
              const reason = "DEPOSIT_AMOUNT_REQUIRES_RECONCILIATION";
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
            const reconciled = await repo.reconcileDeposit({
              applicationId: preContractDeposit.applicationId,
              offerId: preContractDeposit.offerId,
              paymentTransactionId: payment.id,
              amountMinorUnits: input.amountMinorUnits,
              evidenceHash: sha256(input.eventId),
            });
            if (!reconciled.inserted) {
              const reason = "DEPOSIT_ALREADY_RECONCILED";
              await repo.createReconciliationCase({
                paymentTransactionId: payment.id,
                reason,
                dedupeKey: `PRE_CONTRACT_DEPOSIT:${preContractDeposit.applicationId}:${preContractDeposit.offerId}:${payment.id}`,
                resolution: {
                  winnerPaymentTransactionId:
                    reconciled.row.paymentTransactionId,
                  depositReconciliationId: reconciled.row.id,
                },
              });
              await appendAuditEvent(tx, {
                aggregateType: "payment_transaction",
                aggregateId: payment.id,
                action: "DEPOSIT_PAYMENT_QUARANTINED",
                actorStaffUserId: null,
                actorPersonId: preContractDeposit.payerPersonId,
                requestId: null,
                data: {
                  applicationId: preContractDeposit.applicationId,
                  offerId: preContractDeposit.offerId,
                  winnerPaymentTransactionId:
                    reconciled.row.paymentTransactionId,
                  reason,
                },
                occurredAt: input.occurredAt,
              });
              return {
                paymentTransaction: payment,
                outcome: "QUARANTINED",
                ledgerEntryIds: [],
                depositReconciled: false,
                reason,
              };
            }
            const matched = await repo.updateStatus(payment.id, "MATCHED");
            const receipt =
              options.receipts === undefined
                ? await issueReceipt(repo, matched, input.occurredAt)
                : await options.receipts.issue({
                    payment: matched,
                    now: input.occurredAt,
                    transaction: tx,
                  });
            await appendAuditEvent(tx, {
              aggregateType: "payment_transaction",
              aggregateId: matched.id,
              action: "DEPOSIT_RECONCILED_PRE_CONTRACT",
              actorStaffUserId: null,
              actorPersonId: preContractDeposit.payerPersonId,
              requestId: null,
              data: {
                applicationId: preContractDeposit.applicationId,
                offerId: preContractDeposit.offerId,
                offerVersionId: preContractDeposit.offerVersionId,
                receiptId: receipt.id,
                allocationPolicyVersion: input.policy!.version,
              },
              occurredAt: input.occurredAt,
            });
            await enqueueOutbox(tx, {
              id: randomUUID(),
              topic: "payments.deposit_reconciled",
              aggregateType: "payment_transaction",
              aggregateId: matched.id,
              payload: {
                paymentTransactionId: matched.id,
                applicationId: preContractDeposit.applicationId,
                offerId: preContractDeposit.offerId,
                offerVersionId: preContractDeposit.offerVersionId,
                receiptId: receipt.id,
              },
              occurredAt: input.occurredAt,
            });
            return {
              paymentTransaction: matched,
              outcome: "POSTED",
              ledgerEntryIds: [],
              receiptId: receipt.id,
              depositReconciled: true,
            };
          }
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
              policyBehaviorDigest: input.policy!.behaviorDigest,
              policyEvidenceHash: input.policy!.evidence.evidenceHash,
              policyFinanceApprovedBy: input.policy!.evidence.financeApprovedBy,
              policyComplianceApprovedBy:
                input.policy!.evidence.complianceApprovedBy,
              policyFinanceApprovedAt: input.policy!.evidence.financeApprovedAt,
              policyComplianceApprovedAt:
                input.policy!.evidence.complianceApprovedAt,
              ...(input.policyAttestationReference === undefined
                ? {}
                : {
                    policyAttestationReference:
                      input.policyAttestationReference,
                  }),
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
          true,
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
        if (existing !== null) return duplicateResult(repo, existing);
        const existingCompensation = await repo.findCompensationForOriginal(
          original.id,
        );
        if (existingCompensation !== null)
          return duplicateResult(repo, existingCompensation);
        const lifecycle =
          original.contractId === null
            ? null
            : await repo.contractLifecycle(original.contractId);
        const requiresException =
          lifecycle !== null &&
          (lifecycle.status === "SETTLED" ||
            lifecycle.status === "TRANSFERRED" ||
            lifecycle.ownershipHolder === "CUSTOMER");
        const derivedProviderTransactionId = `${original.providerTransactionId}:COMPENSATION`;
        const insertedPayment = await repo.insertIfAbsent(
          {
            id: randomUUID(),
            provider: "SOMOCO_PAYMENTS",
            channel: original.channel,
            providerTransactionId: derivedProviderTransactionId,
            eventId: input.eventId,
            eventType: input.eventType,
            originalPaymentTransactionId: original.id,
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
              compensationLifecycle: "ONE_PER_ORIGINAL_V1",
              ...(requiresException
                ? {
                    quarantineReason:
                      "POST_SETTLEMENT_REVERSAL_REQUIRES_EXCEPTION",
                  }
                : {}),
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
              topic: requiresException
                ? "payments.reversal_quarantined"
                : "payments.payment_reversed",
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
        if (!insertedPayment.inserted)
          return duplicateResult(repo, insertedPayment.payment);
        const payment = insertedPayment.payment;
        if (requiresException && original.contractId !== null) {
          await repo.createReconciliationCase({
            paymentTransactionId: payment.id,
            contractId: original.contractId,
            reason: "POST_SETTLEMENT_REVERSAL_REQUIRES_EXCEPTION",
            dedupeKey: `POST_SETTLEMENT_REVERSAL:${original.id}`,
            resolution: {
              originalPaymentTransactionId: original.id,
              incomingEventId: input.eventId,
              incomingEventType: input.eventType,
              contractStatus: lifecycle?.status,
              ownershipHolder: lifecycle?.ownershipHolder,
            },
          });
          const quarantined = await repo.updateStatus(payment.id, "REJECTED");
          await appendAuditEvent(tx, {
            aggregateType: "payment_transaction",
            aggregateId: payment.id,
            action: "PAYMENT_REVERSAL_QUARANTINED",
            actorStaffUserId: null,
            actorPersonId: null,
            requestId: null,
            data: {
              originalPaymentTransactionId: original.id,
              reason: "POST_SETTLEMENT_REVERSAL_REQUIRES_EXCEPTION",
            },
            occurredAt: input.occurredAt,
          });
          return {
            paymentTransaction: quarantined,
            outcome: "QUARANTINED",
            ledgerEntryIds: [],
            depositReconciled: false,
            reason: "POST_SETTLEMENT_REVERSAL_REQUIRES_EXCEPTION",
          };
        }
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
            postingKey: `COMPENSATION:${entry.id}:ONE_PER_ORIGINAL_V1`,
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
            metadata: {
              reversesEntryId: entry.id,
              compensationLifecycle: "ONE_PER_ORIGINAL_V1",
              originalPaymentTransactionId: original.id,
            },
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
        !input.checker.roles.includes("COMPLIANCE_OFFICER")
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
          const lifecycle = await repo.contractLifecycle(adjustment.contractId);
          if (
            lifecycle !== null &&
            (lifecycle.status === "SETTLED" ||
              lifecycle.status === "TRANSFERRED" ||
              lifecycle.ownershipHolder === "CUSTOMER")
          ) {
            await repo.createReconciliationCase({
              contractId: adjustment.contractId,
              reason: "POST_SETTLEMENT_ADJUSTMENT_REQUIRES_EXCEPTION",
              dedupeKey: `POST_SETTLEMENT_ADJUSTMENT:${adjustment.id}`,
              resolution: {
                adjustmentId: adjustment.id,
                contractStatus: lifecycle.status,
                ownershipHolder: lifecycle.ownershipHolder,
                requestedDecision: input.decision,
              },
            });
            const quarantined = await repo.decideAdjustment({
              id: adjustment.id,
              checkerStaffUserId: input.checker.staffUserId,
              status: "QUARANTINED",
              decisionReason: input.reason,
            });
            await appendAuditEvent(tx, {
              aggregateType: "payment_adjustment",
              aggregateId: quarantined.id,
              action: "PAYMENT_ADJUSTMENT_QUARANTINED",
              actorStaffUserId: input.checker.staffUserId,
              actorPersonId: null,
              requestId: null,
              data: {
                reason: input.reason,
                contractStatus: lifecycle.status,
                ownershipHolder: lifecycle.ownershipHolder,
              },
              occurredAt: new Date(),
            });
            return quarantined;
          }
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
        status: result.status as "APPROVED" | "REJECTED" | "QUARANTINED",
      };
    },
  };
}

export function validateAllocationPolicy(policy: AllocationPolicy): void {
  const candidate = isRecord(policy)
    ? (policy as unknown as Record<string, unknown>)
    : {};
  const evidence = candidate.evidence;
  const evidenceRecord = isRecord(evidence) ? evidence : null;
  const artifact = evidenceRecord?.artifact;
  const artifactRecord = isRecord(artifact) ? artifact : null;
  const hasCallerBehavior = isRecord(policy) && "decide" in candidate;
  if (
    !isRecord(policy) ||
    policy.version !== ALLOCATION_POLICY_VERSION ||
    policy.executionKey !== ALLOCATION_POLICY_EXECUTION_KEY ||
    policy.behaviorDigest !== ALLOCATION_POLICY_BEHAVIOR_DIGEST ||
    !isSha256(evidenceRecord?.evidenceHash) ||
    artifactRecord === null ||
    evidenceRecord?.evidenceHash !==
      hashAllocationEvidenceArtifact(artifactRecord) ||
    !isNonEmptyString(evidenceRecord?.financeApprovedBy) ||
    !isNonEmptyString(evidenceRecord?.complianceApprovedBy) ||
    evidenceRecord.financeApprovedBy === evidenceRecord.complianceApprovedBy ||
    !isNonEmptyString(evidenceRecord?.financeSignature) ||
    !isNonEmptyString(evidenceRecord?.complianceSignature) ||
    !isIsoTimestamp(evidenceRecord?.financeApprovedAt) ||
    !isIsoTimestamp(evidenceRecord?.complianceApprovedAt) ||
    hasCallerBehavior
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
  const evidence = input.evidence;
  const artifact = evidence.artifact;
  if (
    approved.version !== input.version ||
    approved.behaviorDigest !== input.behaviorDigest ||
    approved.behaviorDigest !== ALLOCATION_POLICY_BEHAVIOR_DIGEST ||
    approved.evidenceHash !== evidence.evidenceHash ||
    approved.evidenceHash !== hashAllocationEvidenceArtifact(artifact) ||
    approved.policyHash !== evidence.evidenceHash ||
    approved.workedExampleHash !== evidence.evidenceHash ||
    approved.financeApprovedBy !== evidence.financeApprovedBy ||
    approved.complianceApprovedBy !== evidence.complianceApprovedBy ||
    approved.financeSignature !== evidence.financeSignature ||
    approved.complianceSignature !== evidence.complianceSignature ||
    approved.financeApprovedAt?.toISOString() !== evidence.financeApprovedAt ||
    approved.complianceApprovedAt?.toISOString() !==
      evidence.complianceApprovedAt ||
    approved.approvedAt.toISOString() !== evidence.financeApprovedAt
  )
    return false;
  if (
    approved.evidenceArtifact === null ||
    approved.evidenceArtifact === undefined
  )
    return false;
  const canonicalEvidence = canonicalJson(approved.evidenceArtifact);
  return (
    sha256(canonicalEvidence) === approved.evidenceHash &&
    canonicalEvidence === canonicalJson(artifact) &&
    canonicalJson(approved.workedExample) === canonicalEvidence
  );
}

async function duplicateResult(
  repo: ReturnType<typeof paymentRepo>,
  duplicate: PaymentTransaction,
): Promise<LedgerPostResult> {
  const duplicateLedger = await repo.findLedgerForPayment(duplicate.id);
  const receipt = await repo.findReceipt(duplicate.id);
  const deposit = await repo.findDepositByPaymentTransaction(duplicate.id);
  return {
    paymentTransaction: duplicate,
    outcome:
      duplicate.status === "REVERSED"
        ? "REVERSED"
        : duplicate.status === "REFUNDED"
          ? "REFUNDED"
          : duplicateLedger.length > 0
            ? "POSTED"
            : deposit?.status === "RECONCILED"
              ? "POSTED"
              : "QUARANTINED",
    ledgerEntryIds: duplicateLedger.map((entry) => entry.id),
    ...(receipt === null ? {} : { receiptId: receipt.id }),
    depositReconciled: deposit?.status === "RECONCILED",
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

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
