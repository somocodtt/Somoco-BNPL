import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  collectionsRepo,
  withTransaction,
  type Database,
} from "@somo/db";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface SettlementService {
  approveFinance(input: {
    contractId: string;
    reason: string;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  approveBusiness(input: {
    contractId: string;
    reason: string;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  recordEvidence(input: {
    contractId: string;
    evidenceDocumentReference: string;
    evidenceHash: string;
    verificationStatus: "CLEAN";
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  reconcile(input: {
    contractId: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  settle(input: {
    contractId: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
  transferOwnership(input: {
    contractId: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<Record<string, unknown>>;
}

export function createSettlementService(options: {
  database: Database;
}): SettlementService {
  return {
    async approveFinance(input) {
      requireFinanceApproval(input.actor);
      return createApproval(options.database, {
        ...input,
        approvalType: "FINANCE_RECONCILIATION",
      });
    },
    async approveBusiness(input) {
      if (!input.actor.roles.includes("MD"))
        throw new AppError(
          403,
          "FORBIDDEN",
          "MD business approval is required.",
        );
      return createApproval(options.database, {
        ...input,
        approvalType: "BUSINESS_OWNERSHIP_TRANSFER",
      });
    },
    async recordEvidence(input) {
      if (
        !input.actor.roles.some((role) =>
          ["MD", "INVENTORY_OFFICER", "COMPLIANCE_AUDITOR"].includes(role),
        )
      )
        throw new AppError(
          403,
          "FORBIDDEN",
          "Authorized transfer evidence acceptance is required.",
        );
      if (input.verificationStatus !== "CLEAN")
        throw new AppError(
          409,
          "TRANSFER_EVIDENCE_NOT_CLEAN",
          "Only CLEAN transfer evidence can be accepted.",
        );
      if (!/^[0-9a-f]{64}$/.test(input.evidenceHash))
        throw new AppError(
          400,
          "TRANSFER_EVIDENCE_HASH_INVALID",
          "A SHA-256 evidence hash is required.",
        );
      if (input.evidenceDocumentReference.trim().length === 0)
        throw new AppError(
          400,
          "TRANSFER_EVIDENCE_REQUIRED",
          "Transfer evidence is required.",
        );
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        if ((await repo.findContractContext(input.contractId)) === null)
          throw new AppError(
            404,
            "CONTRACT_NOT_FOUND",
            "The contract was not found.",
          );
        const result = await repo.insertSettlementEvidence({
          id: randomUUID(),
          contractId: input.contractId,
          evidenceDocumentReference: input.evidenceDocumentReference.trim(),
          evidenceHash: input.evidenceHash,
          verificationStatus: "CLEAN",
          acceptedBy: input.actor.staffUserId,
          acceptedAt: new Date(),
        });
        if (result.inserted)
          await appendAuditEvent(tx, {
            aggregateType: "settlement_evidence",
            aggregateId: result.row.id,
            action: "SETTLEMENT_EVIDENCE_ACCEPTED",
            actorStaffUserId: input.actor.staffUserId,
            actorPersonId: null,
            requestId: input.requestId ?? null,
            data: {
              contractId: input.contractId,
              evidenceDocumentReference: input.evidenceDocumentReference.trim(),
              evidenceHash: input.evidenceHash,
              verificationStatus: "CLEAN",
            },
            occurredAt: new Date(),
          });
        return {
          id: result.row.id,
          contractId: result.row.contractId,
          evidenceDocumentReference: result.row.evidenceDocumentReference,
          evidenceHash: result.row.evidenceHash,
          verificationStatus: result.row.verificationStatus,
        };
      });
    },
    async reconcile(input) {
      return settleContract(options.database, input);
    },
    async settle(input) {
      return settleContract(options.database, input);
    },
    async transferOwnership(input) {
      if (
        !input.actor.roles.some((role) =>
          ["MD", "INVENTORY_OFFICER"].includes(role),
        )
      )
        throw new AppError(
          403,
          "FORBIDDEN",
          "Authorized ownership transfer authority is required.",
        );
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const gate = await repo.settlementGate(input.contractId);
        if (gate === null)
          throw new AppError(
            404,
            "CONTRACT_NOT_FOUND",
            "The contract was not found.",
          );
        const workflow = await repo.findSettlementWorkflow(
          input.contractId,
          true,
        );
        if (workflow?.status === "TRANSFERRED")
          return {
            contractId: input.contractId,
            status: "TRANSFERRED",
            ownershipHolder: "CUSTOMER",
            replay: true,
          };
        if (workflow?.status !== "SETTLED")
          throw new AppError(
            409,
            "CONTRACT_NOT_SETTLED",
            "Settlement must commit before ownership transfer.",
          );
        assertGate(gate);
        const approvals = await repo.findSettlementApprovals(input.contractId);
        const finance = approvals.find(
          (item) => item.approvalType === "FINANCE_RECONCILIATION",
        );
        const business = approvals.find(
          (item) => item.approvalType === "BUSINESS_OWNERSHIP_TRANSFER",
        );
        const evidence = await repo.findSettlementEvidence(input.contractId);
        if (
          finance === undefined ||
          business === undefined ||
          evidence === null ||
          evidence.verificationStatus !== "CLEAN"
        )
          throw new AppError(
            409,
            "SETTLEMENT_GATES_INCOMPLETE",
            "All settlement approvals and clean evidence are required.",
          );
        const now = new Date();
        const transfer = await repo.completeOwnershipTransfer({
          contractId: input.contractId,
          approvedBy: input.actor.staffUserId,
          evidence: {
            evidenceId: evidence.id,
            evidenceDocumentReference: evidence.evidenceDocumentReference,
            evidenceHash: evidence.evidenceHash,
            financeApprovalId: finance.id,
            businessApprovalId: business.id,
          },
          transferredAt: now,
        });
        await repo.updateSettlementWorkflow(workflow.id, {
          status: "TRANSFERRED",
          transferredAt: now,
          evidenceId: evidence.id,
          financeApprovalId: finance.id,
          businessApprovalId: business.id,
          version: workflow.version + 1,
        });
        await repo.enqueueSettlementEvent({
          id: randomUUID(),
          topic: "OwnershipTransferred",
          aggregateType: "contract",
          aggregateId: input.contractId,
          payload: {
            contractId: input.contractId,
            ownershipHolderBeforeTransition: "SOMOCO",
            ownershipHolderAfterTransition: "CUSTOMER",
            transferId: transfer.id,
            evidenceId: evidence.id,
          },
          occurredAt: now,
        });
        await appendAuditEvent(tx, {
          aggregateType: "contract",
          aggregateId: input.contractId,
          action: "OWNERSHIP_TRANSFERRED",
          actorStaffUserId: input.actor.staffUserId,
          actorPersonId: null,
          requestId: input.requestId ?? null,
          data: {
            transferId: transfer.id,
            evidenceId: evidence.id,
            ownershipHolderBeforeTransition: "SOMOCO",
          },
          occurredAt: now,
        });
        return {
          contractId: input.contractId,
          status: "TRANSFERRED",
          ownershipHolder: "CUSTOMER",
          transferId: transfer.id,
          replay: false,
        };
      });
    },
  };
}

async function createApproval(
  database: Database,
  input: {
    contractId: string;
    reason: string;
    idempotencyKey: string;
    actor: StaffPrincipal;
    requestId?: string;
    approvalType: "FINANCE_RECONCILIATION" | "BUSINESS_OWNERSHIP_TRANSFER";
  },
): Promise<Record<string, unknown>> {
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 4000)
    throw new AppError(
      400,
      "SETTLEMENT_REASON_REQUIRED",
      "An approval reason is required.",
    );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(input.idempotencyKey))
    throw new AppError(
      400,
      "SETTLEMENT_IDEMPOTENCY_INVALID",
      "A valid idempotency key is required.",
    );
  return withTransaction(database, async (tx) => {
    const repo = collectionsRepo(tx);
    if ((await repo.findContractContext(input.contractId)) === null)
      throw new AppError(
        404,
        "CONTRACT_NOT_FOUND",
        "The contract was not found.",
      );
    const existingType = await repo.findSettlementApproval(
      input.contractId,
      input.approvalType,
    );
    if (existingType !== null)
      return {
        id: existingType.id,
        contractId: input.contractId,
        approvalType: existingType.approvalType,
        replay: true,
      };
    const oppositeType =
      input.approvalType === "FINANCE_RECONCILIATION"
        ? "BUSINESS_OWNERSHIP_TRANSFER"
        : "FINANCE_RECONCILIATION";
    const opposite = await repo.findSettlementApproval(
      input.contractId,
      oppositeType,
    );
    if (opposite?.approvedBy === input.actor.staffUserId)
      throw new AppError(
        409,
        "SETTLEMENT_APPROVER_SEPARATION_REQUIRED",
        "Finance and business settlement approvals require separate authorized staff.",
      );
    const now = new Date();
    const result = await repo.insertSettlementApproval({
      id: randomUUID(),
      contractId: input.contractId,
      approvalType: input.approvalType,
      idempotencyKey: input.idempotencyKey,
      approvedBy: input.actor.staffUserId,
      reason,
      approvedAt: now,
    });
    if (
      result.row.contractId !== input.contractId ||
      result.row.approvalType !== input.approvalType
    )
      throw new AppError(
        409,
        "SETTLEMENT_IDEMPOTENCY_KEY_REUSED",
        "The settlement approval idempotency key is already bound to another approval.",
      );
    if (result.inserted)
      await appendAuditEvent(tx, {
        aggregateType: "contract",
        aggregateId: input.contractId,
        action:
          input.approvalType === "FINANCE_RECONCILIATION"
            ? "FINANCE_SETTLEMENT_APPROVED"
            : "BUSINESS_TRANSFER_APPROVED",
        actorStaffUserId: input.actor.staffUserId,
        actorPersonId: null,
        requestId: input.requestId ?? null,
        data: {
          approvalId: result.row.id,
          approvalType: input.approvalType,
          reason,
        },
        occurredAt: now,
      });
    return {
      id: result.row.id,
      contractId: input.contractId,
      approvalType: result.row.approvalType,
      replay: !result.inserted,
    };
  });
}

async function settleContract(
  database: Database,
  input: { contractId: string; actor: StaffPrincipal; requestId?: string },
): Promise<Record<string, unknown>> {
  if (
    !input.actor.roles.some((role) =>
      ["CFO", "MD", "FINANCE_OFFICER"].includes(role),
    )
  )
    throw new AppError(403, "FORBIDDEN", "Settlement authority is required.");
  return withTransaction(database, async (tx) => {
    const repo = collectionsRepo(tx);
    const gate = await repo.settlementGate(input.contractId);
    if (gate === null)
      throw new AppError(
        404,
        "CONTRACT_NOT_FOUND",
        "The contract was not found.",
      );
    const workflow = await repo.findSettlementWorkflow(input.contractId, true);
    if (workflow?.status === "SETTLED" || workflow?.status === "TRANSFERRED")
      return {
        contractId: input.contractId,
        status: workflow.status,
        ownershipHolder: "SOMOCO",
        replay: true,
      };
    if (gate.contract_status !== "ACTIVE" || BigInt(gate.balance) !== 0n)
      throw new AppError(
        409,
        "CONTRACT_BALANCE_OUTSTANDING",
        "The contractual balance must be zero before settlement.",
      );
    assertGate(gate);
    const approvals = await repo.findSettlementApprovals(input.contractId);
    const finance = approvals.find(
      (item) => item.approvalType === "FINANCE_RECONCILIATION",
    );
    const business = approvals.find(
      (item) => item.approvalType === "BUSINESS_OWNERSHIP_TRANSFER",
    );
    const evidence = await repo.findSettlementEvidence(input.contractId);
    if (
      finance === undefined ||
      business === undefined ||
      evidence === null ||
      evidence.verificationStatus !== "CLEAN"
    )
      throw new AppError(
        409,
        "SETTLEMENT_GATES_INCOMPLETE",
        "Finance, business, and clean evidence gates are required.",
      );
    const now = new Date();
    const workflowRow =
      workflow ?? (await repo.createSettlementWorkflow(input.contractId));
    const marked = await repo.markContractSettled(input.contractId, now);
    if (!marked) {
      const current = await repo.findSettlementWorkflow(input.contractId);
      if (current?.status === "SETTLED" || current?.status === "TRANSFERRED")
        return {
          contractId: input.contractId,
          status: current.status,
          ownershipHolder: "SOMOCO",
          replay: true,
        };
      throw new AppError(
        409,
        "SETTLEMENT_RACE",
        "The contract changed before settlement could commit.",
      );
    }
    await repo.updateSettlementWorkflow(workflowRow.id, {
      status: "SETTLED",
      financeApprovalId: finance.id,
      businessApprovalId: business.id,
      evidenceId: evidence.id,
      settledAt: now,
      version: workflowRow.version + 1,
    });
    await repo.enqueueSettlementEvent({
      id: randomUUID(),
      topic: "ContractSettled",
      aggregateType: "contract",
      aggregateId: input.contractId,
      payload: {
        contractId: input.contractId,
        ownershipHolder: "SOMOCO",
        financeApprovalId: finance.id,
        businessApprovalId: business.id,
        evidenceId: evidence.id,
      },
      occurredAt: now,
    });
    await appendAuditEvent(tx, {
      aggregateType: "contract",
      aggregateId: input.contractId,
      action: "CONTRACT_SETTLED",
      actorStaffUserId: input.actor.staffUserId,
      actorPersonId: null,
      requestId: input.requestId ?? null,
      data: {
        financeApprovalId: finance.id,
        businessApprovalId: business.id,
        evidenceId: evidence.id,
        ownershipHolder: "SOMOCO",
      },
      occurredAt: now,
    });
    return {
      contractId: input.contractId,
      status: "SETTLED",
      ownershipHolder: "SOMOCO",
      replay: false,
    };
  });
}

function assertGate(gate: {
  unresolved_reconciliation: boolean;
  unresolved_payment: boolean;
  reversed_payment: boolean;
}): void {
  if (
    gate.unresolved_reconciliation ||
    gate.unresolved_payment ||
    gate.reversed_payment
  )
    throw new AppError(
      409,
      "SETTLEMENT_RECONCILIATION_INCOMPLETE",
      "All payment reconciliation, reversal, and unmatched gates must be clear.",
    );
}

function requireFinanceApproval(actor: StaffPrincipal): void {
  if (
    !actor.roles.some((role) =>
      ["FINANCE_OFFICER", "CFO", "COMPLIANCE_AUDITOR"].includes(role),
    )
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Finance reconciliation approval is required.",
    );
}
