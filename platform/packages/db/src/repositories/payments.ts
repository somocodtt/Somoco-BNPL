import { and, asc, desc, eq, sql } from "drizzle-orm";
import { contract, installment } from "../schema/contracts.js";
import {
  ledgerEntry,
  paymentAdjustment,
  paymentAllocationPolicy,
  paymentReceipt,
  paymentSettlementBatch,
  paymentTransaction,
  reconciliationCase,
  depositReconciliation,
} from "../schema/payments.js";
import {
  getInternalTransaction,
  type DatabaseTransaction,
} from "../transaction.js";
import { persistWriteEffects, type WriteEffects } from "./effects.js";

export type NewPaymentTransaction = typeof paymentTransaction.$inferInsert;
export type PaymentTransaction = typeof paymentTransaction.$inferSelect;
export type PaymentReceipt = typeof paymentReceipt.$inferSelect;
export type ReconciliationCase = typeof reconciliationCase.$inferSelect;
export type PaymentAdjustment = typeof paymentAdjustment.$inferSelect;
export type PaymentSettlementBatch = typeof paymentSettlementBatch.$inferSelect;
export type PaymentAllocationPolicy =
  typeof paymentAllocationPolicy.$inferSelect;

export interface ContractPaymentContext {
  contractId: string;
  applicationId: string;
  offerId: string;
  offerVersionId: string;
  depositMinorUnits: bigint;
  outstandingBalanceMinorUnits: bigint;
  payerPersonId: string;
}

export interface InstallmentPaymentRow {
  id: string;
  installmentNumber: number;
  amountMinorUnits: bigint;
  paidMinorUnits: bigint;
  dueDate: string;
}

export function paymentRepo(db: DatabaseTransaction) {
  const executor = getInternalTransaction(db);
  return {
    async insert(input: NewPaymentTransaction, effects: WriteEffects) {
      const [inserted] = await executor
        .insert(paymentTransaction)
        .values(input)
        .returning();
      if (inserted === undefined) {
        throw new Error("PAYMENT_TRANSACTION_INSERT_FAILED");
      }
      await persistWriteEffects(db, effects);
      return inserted;
    },
    async insertIfAbsent(
      input: NewPaymentTransaction,
      effects: WriteEffects,
    ): Promise<{ payment: PaymentTransaction; inserted: boolean }> {
      const [inserted] = await executor
        .insert(paymentTransaction)
        .values(input)
        .onConflictDoNothing({
          target: [
            paymentTransaction.provider,
            paymentTransaction.providerTransactionId,
          ],
        })
        .returning();
      if (inserted !== undefined) {
        await persistWriteEffects(db, effects);
        return { payment: inserted, inserted: true };
      }
      const existing = await this.findByProviderTransaction(
        input.provider,
        input.providerTransactionId,
      );
      if (existing === null)
        throw new Error("PAYMENT_TRANSACTION_DEDUPLICATION_FAILED");
      return { payment: existing, inserted: false };
    },
    async findByProviderTransaction(
      provider: string,
      providerTransactionId: string,
    ): Promise<PaymentTransaction | null> {
      const [row] = await executor
        .select()
        .from(paymentTransaction)
        .where(
          and(
            eq(paymentTransaction.provider, provider as "SOMOCO_PAYMENTS"),
            eq(paymentTransaction.providerTransactionId, providerTransactionId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async findByEventId(
      provider: string,
      eventId: string,
    ): Promise<PaymentTransaction | null> {
      const [row] = await executor
        .select()
        .from(paymentTransaction)
        .where(
          and(
            eq(paymentTransaction.provider, provider as "SOMOCO_PAYMENTS"),
            eq(paymentTransaction.eventId, eventId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async findApprovedAllocationPolicy(
      version: string,
    ): Promise<PaymentAllocationPolicy | null> {
      const [row] = await executor
        .select()
        .from(paymentAllocationPolicy)
        .where(
          and(
            eq(paymentAllocationPolicy.version, version),
            eq(paymentAllocationPolicy.status, "APPROVED"),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async findContractByReference(
      reference: string,
    ): Promise<ContractPaymentContext | null> {
      const result = await executor.execute<{
        contract_id: string;
        application_id: string;
        offer_id: string;
        offer_version_id: string;
        deposit_minor_units: bigint | string;
        outstanding_balance_minor_units: bigint | string;
        payer_person_id: string;
      }>(sql`
        select c.id as contract_id,
               c.application_id,
               ov.offer_id,
               ov.id as offer_version_id,
               ov.deposit_minor_units,
               c.outstanding_balance_minor_units,
               a.applicant_person_id as payer_person_id
          from contract c
          join application a on a.id = c.application_id
          join offer_version ov on ov.id = c.offer_version_id
         where c.reference = ${reference}
            or c.id::text = ${reference}
         limit 1
      `);
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        contractId: row.contract_id,
        applicationId: row.application_id,
        offerId: row.offer_id,
        offerVersionId: row.offer_version_id,
        depositMinorUnits: BigInt(row.deposit_minor_units),
        outstandingBalanceMinorUnits: BigInt(
          row.outstanding_balance_minor_units,
        ),
        payerPersonId: row.payer_person_id,
      };
    },
    async listInstallments(
      contractId: string,
    ): Promise<InstallmentPaymentRow[]> {
      const rows = await executor
        .select({
          id: installment.id,
          installmentNumber: installment.installmentNumber,
          amountMinorUnits: installment.amountMinorUnits,
          paidMinorUnits: installment.paidMinorUnits,
          dueDate: installment.dueDate,
        })
        .from(installment)
        .where(eq(installment.contractId, contractId))
        .orderBy(asc(installment.installmentNumber));
      return rows.map((row) => ({
        ...row,
        amountMinorUnits: BigInt(row.amountMinorUnits),
        paidMinorUnits: BigInt(row.paidMinorUnits),
      }));
    },
    async appendLedger(
      entry: typeof ledgerEntry.$inferInsert,
    ): Promise<typeof ledgerEntry.$inferSelect> {
      const [inserted] = await executor
        .insert(ledgerEntry)
        .values(entry)
        .onConflictDoNothing({ target: ledgerEntry.postingKey })
        .returning();
      if (inserted !== undefined) return inserted;
      const [existing] = await executor
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.postingKey, entry.postingKey))
        .limit(1);
      if (existing === undefined)
        throw new Error("LEDGER_ENTRY_DEDUPLICATION_FAILED");
      return existing;
    },
    async updatePaymentAggregates(input: {
      contractId: string;
      installmentId: string;
      paymentMinorUnits: bigint;
    }): Promise<{ balanceAfterMinorUnits: bigint }> {
      const [current] = await executor
        .select({ outstanding: contract.outstandingBalanceMinorUnits })
        .from(contract)
        .where(eq(contract.id, input.contractId))
        .limit(1)
        .for("update");
      if (current === undefined) throw new Error("CONTRACT_NOT_FOUND");
      const [inst] = await executor
        .select({
          amount: installment.amountMinorUnits,
          paid: installment.paidMinorUnits,
        })
        .from(installment)
        .where(
          and(
            eq(installment.id, input.installmentId),
            eq(installment.contractId, input.contractId),
          ),
        )
        .limit(1)
        .for("update");
      if (inst === undefined) throw new Error("INSTALLMENT_NOT_FOUND");
      const amount = BigInt(inst.amount);
      const paid = BigInt(inst.paid);
      if (paid + input.paymentMinorUnits > amount)
        throw new Error("INSTALLMENT_ALLOCATION_EXCEEDS_DUE");
      const balanceBefore = BigInt(current.outstanding);
      if (input.paymentMinorUnits > balanceBefore)
        throw new Error("CONTRACT_BALANCE_EXCEEDED");
      const balanceAfter = balanceBefore - input.paymentMinorUnits;
      const paidAfter = paid + input.paymentMinorUnits;
      const status = paidAfter === amount ? "PAID" : "PARTIALLY_PAID";
      await executor
        .update(installment)
        .set({
          paidMinorUnits: paidAfter,
          status,
          version: sql`${installment.version} + 1`,
        })
        .where(
          and(
            eq(installment.id, input.installmentId),
            eq(installment.contractId, input.contractId),
          ),
        );
      await executor
        .update(contract)
        .set({
          outstandingBalanceMinorUnits: balanceAfter,
          version: sql`${contract.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(contract.id, input.contractId));
      return { balanceAfterMinorUnits: balanceAfter };
    },
    async reversePaymentAggregates(input: {
      contractId: string;
      installmentId: string;
      paymentMinorUnits: bigint;
    }): Promise<{ balanceAfterMinorUnits: bigint }> {
      if (input.paymentMinorUnits <= 0n) {
        throw new Error("PAYMENT_AMOUNT_INVALID");
      }
      const [current] = await executor
        .select({ outstanding: contract.outstandingBalanceMinorUnits })
        .from(contract)
        .where(eq(contract.id, input.contractId))
        .limit(1)
        .for("update");
      if (current === undefined) throw new Error("CONTRACT_NOT_FOUND");
      const [inst] = await executor
        .select({
          amount: installment.amountMinorUnits,
          paid: installment.paidMinorUnits,
        })
        .from(installment)
        .where(
          and(
            eq(installment.id, input.installmentId),
            eq(installment.contractId, input.contractId),
          ),
        )
        .limit(1)
        .for("update");
      if (inst === undefined) throw new Error("INSTALLMENT_NOT_FOUND");
      const paid = BigInt(inst.paid);
      if (input.paymentMinorUnits > paid) {
        throw new Error("INSTALLMENT_REVERSAL_EXCEEDS_PAID");
      }
      const balanceAfter =
        BigInt(current.outstanding) + input.paymentMinorUnits;
      const paidAfter = paid - input.paymentMinorUnits;
      const amount = BigInt(inst.amount);
      const status =
        paidAfter === 0n
          ? "PENDING"
          : paidAfter === amount
            ? "PAID"
            : "PARTIALLY_PAID";
      await executor
        .update(installment)
        .set({
          paidMinorUnits: paidAfter,
          status,
          version: sql`${installment.version} + 1`,
        })
        .where(
          and(
            eq(installment.id, input.installmentId),
            eq(installment.contractId, input.contractId),
          ),
        );
      await executor
        .update(contract)
        .set({
          outstandingBalanceMinorUnits: balanceAfter,
          version: sql`${contract.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(contract.id, input.contractId));
      return { balanceAfterMinorUnits: balanceAfter };
    },
    async adjustContractBalance(input: {
      contractId: string;
      amountMinorUnits: bigint;
      direction: "DEBIT" | "CREDIT";
    }): Promise<{ balanceAfterMinorUnits: bigint }> {
      if (input.amountMinorUnits <= 0n)
        throw new Error("PAYMENT_AMOUNT_INVALID");
      const delta =
        input.direction === "CREDIT"
          ? -input.amountMinorUnits
          : input.amountMinorUnits;
      const result = await executor.execute<{
        outstanding_balance_minor_units: bigint | string;
      }>(sql`
        update contract
           set outstanding_balance_minor_units = outstanding_balance_minor_units + ${delta},
               version = version + 1,
               updated_at = now()
         where id = ${input.contractId}
           and outstanding_balance_minor_units + ${delta} >= 0
        returning outstanding_balance_minor_units
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("CONTRACT_BALANCE_EXCEEDED");
      return {
        balanceAfterMinorUnits: BigInt(row.outstanding_balance_minor_units),
      };
    },
    async updateStatus(
      paymentTransactionId: string,
      status:
        | "RECEIVED"
        | "MATCHED"
        | "POSTED"
        | "REVERSED"
        | "REFUNDED"
        | "REJECTED",
    ): Promise<PaymentTransaction> {
      const [updated] = await executor
        .update(paymentTransaction)
        .set({
          status,
          updatedAt: new Date(),
          version: sql`${paymentTransaction.version} + 1`,
        })
        .where(eq(paymentTransaction.id, paymentTransactionId))
        .returning();
      if (updated === undefined)
        throw new Error("PAYMENT_STATUS_UPDATE_FAILED");
      return updated;
    },
    async findLedgerForPayment(paymentTransactionId: string) {
      return executor
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.paymentTransactionId, paymentTransactionId))
        .orderBy(asc(ledgerEntry.createdAt));
    },
    async reconcileDeposit(input: {
      applicationId: string;
      offerId: string;
      paymentTransactionId: string;
      amountMinorUnits: bigint;
      evidenceHash: string;
    }) {
      const [row] = await executor
        .insert(depositReconciliation)
        .values({
          applicationId: input.applicationId,
          offerId: input.offerId,
          paymentTransactionId: input.paymentTransactionId,
          amountMinorUnits: input.amountMinorUnits,
          currency: "GHS",
          status: "RECONCILED",
          reconciledAt: new Date(),
          evidenceHash: input.evidenceHash,
        })
        .onConflictDoUpdate({
          target: [
            depositReconciliation.applicationId,
            depositReconciliation.offerId,
          ],
          set: {
            paymentTransactionId: input.paymentTransactionId,
            amountMinorUnits: input.amountMinorUnits,
            status: "RECONCILED",
            reconciledAt: new Date(),
            evidenceHash: input.evidenceHash,
            version: sql`${depositReconciliation.version} + 1`,
          },
        })
        .returning();
      if (row === undefined) throw new Error("DEPOSIT_RECONCILIATION_FAILED");
      return row;
    },
    async invalidateDeposit(input: {
      paymentTransactionId: string;
      reason: string;
    }) {
      const [row] = await executor
        .update(depositReconciliation)
        .set({
          status: "REJECTED",
          reconciledAt: null,
          evidenceHash: input.reason,
          version: sql`${depositReconciliation.version} + 1`,
        })
        .where(
          and(
            eq(
              depositReconciliation.paymentTransactionId,
              input.paymentTransactionId,
            ),
            eq(depositReconciliation.status, "RECONCILED"),
          ),
        )
        .returning();
      return row ?? null;
    },
    async createReconciliationCase(input: {
      paymentTransactionId?: string;
      reason: string;
      dedupeKey?: string;
      resolution?: Record<string, unknown>;
    }): Promise<ReconciliationCase> {
      const existing =
        input.paymentTransactionId === undefined
          ? undefined
          : (
              await executor
                .select()
                .from(reconciliationCase)
                .where(
                  and(
                    eq(
                      reconciliationCase.paymentTransactionId,
                      input.paymentTransactionId,
                    ),
                    eq(reconciliationCase.reason, input.reason),
                    eq(reconciliationCase.status, "OPEN"),
                  ),
                )
                .limit(1)
            )[0];
      if (existing !== undefined) return existing;
      const values = {
        ...(input.paymentTransactionId === undefined
          ? {}
          : { paymentTransactionId: input.paymentTransactionId }),
        reason: input.reason,
        ...(input.dedupeKey === undefined
          ? {}
          : { dedupeKey: input.dedupeKey }),
        ...(input.resolution === undefined
          ? {}
          : { resolution: input.resolution }),
      };
      const [inserted] =
        input.dedupeKey === undefined
          ? await executor.insert(reconciliationCase).values(values).returning()
          : await executor
              .insert(reconciliationCase)
              .values(values)
              .onConflictDoNothing({
                target: reconciliationCase.dedupeKey,
                where: sql`${reconciliationCase.dedupeKey} is not null`,
              })
              .returning();
      if (inserted !== undefined) return inserted;
      if (input.dedupeKey !== undefined) {
        const [existingByKey] = await executor
          .select()
          .from(reconciliationCase)
          .where(eq(reconciliationCase.dedupeKey, input.dedupeKey))
          .limit(1);
        if (existingByKey !== undefined) return existingByKey;
      }
      throw new Error("RECONCILIATION_CASE_CREATE_FAILED");
    },
    async findReceipt(
      paymentTransactionId: string,
    ): Promise<PaymentReceipt | null> {
      const [row] = await executor
        .select()
        .from(paymentReceipt)
        .where(eq(paymentReceipt.paymentTransactionId, paymentTransactionId))
        .limit(1);
      return row ?? null;
    },
    async issueReceiptIfAbsent(
      input: typeof paymentReceipt.$inferInsert,
    ): Promise<{ receipt: PaymentReceipt; inserted: boolean }> {
      const [inserted] = await executor
        .insert(paymentReceipt)
        .values(input)
        .onConflictDoNothing({ target: paymentReceipt.paymentTransactionId })
        .returning();
      if (inserted !== undefined) return { receipt: inserted, inserted: true };
      const existing = await this.findReceipt(input.paymentTransactionId);
      if (existing === null)
        throw new Error("PAYMENT_RECEIPT_DEDUPLICATION_FAILED");
      return { receipt: existing, inserted: false };
    },
    async issueReceipt(
      input: typeof paymentReceipt.$inferInsert,
    ): Promise<PaymentReceipt> {
      return (await this.issueReceiptIfAbsent(input)).receipt;
    },
    async createAdjustment(
      input: typeof paymentAdjustment.$inferInsert,
    ): Promise<PaymentAdjustment> {
      const [inserted] = await executor
        .insert(paymentAdjustment)
        .values(input)
        .onConflictDoNothing({ target: paymentAdjustment.idempotencyKey })
        .returning();
      if (inserted !== undefined) return inserted;
      const [existing] = await executor
        .select()
        .from(paymentAdjustment)
        .where(eq(paymentAdjustment.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing === undefined)
        throw new Error("PAYMENT_ADJUSTMENT_DEDUPLICATION_FAILED");
      return existing;
    },
    async findAdjustment(id: string): Promise<PaymentAdjustment | null> {
      const [row] = await executor
        .select()
        .from(paymentAdjustment)
        .where(eq(paymentAdjustment.id, id))
        .limit(1);
      return row ?? null;
    },
    async decideAdjustment(input: {
      id: string;
      checkerStaffUserId: string;
      status: "APPROVED" | "REJECTED";
      decisionReason: string;
      ledgerEntryId?: string;
    }): Promise<PaymentAdjustment> {
      const [updated] = await executor
        .update(paymentAdjustment)
        .set({
          checkerStaffUserId: input.checkerStaffUserId,
          status: input.status,
          decisionAt: new Date(),
          decisionReason: input.decisionReason,
          ...(input.ledgerEntryId === undefined
            ? {}
            : { ledgerEntryId: input.ledgerEntryId }),
        })
        .where(
          and(
            eq(paymentAdjustment.id, input.id),
            eq(paymentAdjustment.status, "PENDING"),
          ),
        )
        .returning();
      if (updated === undefined)
        throw new Error("PAYMENT_ADJUSTMENT_ALREADY_DECIDED");
      return updated;
    },
    async insertSettlementBatch(
      input: typeof paymentSettlementBatch.$inferInsert,
    ): Promise<PaymentSettlementBatch> {
      const [inserted] = await executor
        .insert(paymentSettlementBatch)
        .values(input)
        .onConflictDoNothing({
          target: [
            paymentSettlementBatch.provider,
            paymentSettlementBatch.settlementReference,
          ],
        })
        .returning();
      if (inserted !== undefined) return inserted;
      const [existing] = await executor
        .select()
        .from(paymentSettlementBatch)
        .where(
          and(
            eq(paymentSettlementBatch.provider, input.provider),
            eq(
              paymentSettlementBatch.settlementReference,
              input.settlementReference,
            ),
          ),
        )
        .limit(1);
      if (existing === undefined)
        throw new Error("SETTLEMENT_DEDUPLICATION_FAILED");
      return existing;
    },
    async findSettlementBatch(
      provider: "SOMOCO_PAYMENTS",
      settlementReference: string,
    ): Promise<PaymentSettlementBatch | null> {
      const [row] = await executor
        .select()
        .from(paymentSettlementBatch)
        .where(
          and(
            eq(paymentSettlementBatch.provider, provider),
            eq(paymentSettlementBatch.settlementReference, settlementReference),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async sumLedgerForSettlement(settlementReference: string): Promise<bigint> {
      const result = await executor.execute<{ total: bigint | string }>(
        sql`select coalesce(sum(case when l.direction = 'CREDIT' then l.amount_minor_units else -l.amount_minor_units end), 0)::bigint as total from ledger_entry l join payment_transaction p on p.id = l.payment_transaction_id where p.settlement_reference = ${settlementReference}`,
      );
      return BigInt(result.rows[0]?.total ?? 0);
    },
    async listCustomerPayments(personId: string) {
      const result = await executor.execute<{
        id: string;
        provider_transaction_id: string;
        amount_minor_units: bigint | string;
        currency: string;
        status: string;
        occurred_at: Date;
        contract_reference: string | null;
        outstanding_balance_minor_units: bigint | string | null;
        next_due_date: string | null;
      }>(sql`
        select p.id, p.provider_transaction_id, p.amount_minor_units,
               p.currency, p.status, p.occurred_at, c.reference as contract_reference,
               c.outstanding_balance_minor_units,
               (select i.due_date from installment i
                 where i.contract_id = c.id and i.status <> 'PAID'
                 order by i.installment_number asc limit 1) as next_due_date
          from payment_transaction p
          left join contract c on c.id = p.contract_id
         left join application a on a.id = c.application_id
         where a.applicant_person_id = ${personId}
           and p.status = 'POSTED'
           and exists (
             select 1
               from ledger_entry l
              where l.payment_transaction_id = p.id
                and l.direction = 'CREDIT'
           )
         order by p.occurred_at desc, p.id desc
      `);
      return result.rows.map((row) => ({
        id: row.id,
        providerTransactionId: row.provider_transaction_id,
        amountMinorUnits: String(row.amount_minor_units),
        currency: row.currency,
        status: row.status,
        occurredAt: new Date(row.occurred_at).toISOString(),
        contractReference: row.contract_reference,
        outstandingBalanceMinorUnits:
          row.outstanding_balance_minor_units === null
            ? null
            : String(row.outstanding_balance_minor_units),
        nextDueDate: row.next_due_date,
      }));
    },
    async listCustomerAccounts(personId: string) {
      const result = await executor.execute<{
        contract_id: string;
        contract_reference: string;
        outstanding_balance_minor_units: bigint | string;
        next_due_date: string | null;
      }>(sql`
        select c.id as contract_id,
               c.reference as contract_reference,
               c.outstanding_balance_minor_units,
               (select i.due_date from installment i
                 where i.contract_id = c.id and i.status <> 'PAID'
                 order by i.installment_number asc limit 1) as next_due_date
          from contract c
          join application a on a.id = c.application_id
         where a.applicant_person_id = ${personId}
         order by c.reference asc
      `);
      return result.rows.map((row) => ({
        contractId: row.contract_id,
        contractReference: row.contract_reference,
        outstandingBalanceMinorUnits: String(
          row.outstanding_balance_minor_units,
        ),
        nextDueDate: row.next_due_date,
      }));
    },
    async listCustomerReceipts(personId: string) {
      const result = await executor.execute<{
        id: string;
        receipt_number: string;
        payment_transaction_id: string;
        amount_minor_units: bigint | string;
        currency: string;
        issued_at: Date;
        secure_path: string;
      }>(sql`
        select r.id, r.receipt_number, r.payment_transaction_id,
               r.amount_minor_units, r.currency, r.issued_at, r.secure_path
          from payment_receipt r
          join payment_transaction p on p.id = r.payment_transaction_id
          join contract c on c.id = r.contract_id
         join application a on a.id = c.application_id
         where a.applicant_person_id = ${personId}
           and p.status = 'POSTED'
           and exists (
             select 1
               from ledger_entry l
              where l.payment_transaction_id = p.id
                and l.direction = 'CREDIT'
           )
         order by r.issued_at desc, r.id desc
      `);
      return result.rows.map((row) => ({
        id: row.id,
        receiptNumber: row.receipt_number,
        paymentTransactionId: row.payment_transaction_id,
        amountMinorUnits: String(row.amount_minor_units),
        currency: row.currency,
        issuedAt: new Date(row.issued_at).toISOString(),
        securePath: row.secure_path,
      }));
    },
    async getCustomerReceipt(personId: string, receiptId: string) {
      const result = await executor.execute<{
        id: string;
        receipt_number: string;
        payment_transaction_id: string;
        amount_minor_units: bigint | string;
        currency: string;
        issued_at: Date;
        secure_path: string;
        status: string;
        provider_transaction_id: string;
        occurred_at: Date;
      }>(sql`
        select r.id, r.receipt_number, r.payment_transaction_id,
               r.amount_minor_units, r.currency, r.issued_at, r.secure_path,
               p.status, p.provider_transaction_id, p.occurred_at
          from payment_receipt r
          join payment_transaction p on p.id = r.payment_transaction_id
          join contract c on c.id = r.contract_id
          join application a on a.id = c.application_id
         where r.id = ${receiptId}
           and a.applicant_person_id = ${personId}
           and p.status = 'POSTED'
           and exists (
             select 1
               from ledger_entry l
              where l.payment_transaction_id = p.id
                and l.direction = 'CREDIT'
           )
         limit 1
      `);
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        id: row.id,
        receiptNumber: row.receipt_number,
        paymentTransactionId: row.payment_transaction_id,
        amountMinorUnits: String(row.amount_minor_units),
        currency: row.currency,
        issuedAt: new Date(row.issued_at).toISOString(),
        securePath: row.secure_path,
        status: row.status,
        providerTransactionId: row.provider_transaction_id,
        occurredAt: new Date(row.occurred_at).toISOString(),
      };
    },
    async listFinanceInbox() {
      const result = await executor.execute<{
        id: string;
        provider_event_id: string;
        event_type: string;
        received_at: Date;
        processed_at: Date | null;
        result: unknown;
      }>(
        sql`select id, provider_event_id, event_type, received_at, processed_at, result from inbox_message where provider = 'SOMOCO_PAYMENTS' order by received_at desc, id desc`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        providerEventId: row.provider_event_id,
        eventType: row.event_type,
        receivedAt: new Date(row.received_at).toISOString(),
        processedAt:
          row.processed_at === null
            ? null
            : new Date(row.processed_at).toISOString(),
        result: row.result,
      }));
    },
    async listReconciliationCases() {
      const rows = await executor
        .select()
        .from(reconciliationCase)
        .orderBy(desc(reconciliationCase.createdAt));
      return rows;
    },
    async resolveReconciliationCase(
      caseId: string,
      staffUserId: string,
      resolution: Record<string, unknown>,
    ) {
      const [updated] = await executor
        .update(reconciliationCase)
        .set({
          status: "RESOLVED",
          resolvedBy: staffUserId,
          resolution,
          updatedAt: new Date(),
          version: sql`${reconciliationCase.version} + 1`,
        })
        .where(
          and(
            eq(reconciliationCase.id, caseId),
            eq(reconciliationCase.status, "OPEN"),
          ),
        )
        .returning();
      if (updated === undefined)
        throw new Error("RECONCILIATION_CASE_NOT_OPEN");
      return updated;
    },
    async listSettlementBatches() {
      const rows = await executor
        .select()
        .from(paymentSettlementBatch)
        .orderBy(desc(paymentSettlementBatch.receivedAt));
      return rows;
    },
    async listAdjustments() {
      const rows = await executor
        .select()
        .from(paymentAdjustment)
        .orderBy(desc(paymentAdjustment.createdAt));
      return rows;
    },
  };
}
