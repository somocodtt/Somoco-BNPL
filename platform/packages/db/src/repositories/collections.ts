import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "../transaction.js";
import { getInternalTransaction } from "../transaction.js";
import {
  arrearsEscalation,
  recoveryAction,
  recoveryDecision,
  recoveryLocationLookup,
  settlementApproval,
  settlementEvidence,
  settlementWorkflow,
} from "../schema/collections.js";
import { arrearsSnapshot } from "../schema/payments.js";
import { ownershipTransfer, recoveryCase } from "../schema/contracts.js";
import { type NewOutboxMessage } from "../outbox.js";
import {
  deliveryAttempt,
  notification,
  outboxMessage,
} from "../schema/integrations.js";

export interface ArrearsInstallmentRow {
  id: string;
  installmentNumber: number;
  dueDate: string;
  amountMinor: bigint;
  postedMinor: bigint;
}

export interface CollectionContractContext {
  contractId: string;
  reference: string;
  applicantPersonId: string;
  phoneE164: string;
  vehicleUnitId: string;
  status: string;
  outstandingBalanceMinorUnits: bigint;
}

export function collectionsRepo(tx: DatabaseTransaction) {
  const executor = getInternalTransaction(tx);
  return {
    async listArrearsInstallments(
      contractId: string,
      asOfDate: string,
    ): Promise<ArrearsInstallmentRow[]> {
      const result = await executor.execute<{
        id: string;
        installment_number: number;
        due_date: string;
        amount_minor_units: bigint | string;
        posted_minor: bigint | string;
      }>(sql`
        select i.id,
               i.installment_number,
               i.due_date,
               i.amount_minor_units,
               coalesce(sum(case when l.direction = 'CREDIT'
                                 then l.amount_minor_units
                                 else -l.amount_minor_units end), 0)::bigint as posted_minor
          from installment i
           left join ledger_entry l
            on l.installment_id = i.id
           and l.contract_id = i.contract_id
           and l.occurred_at < (${asOfDate}::date + interval '1 day')
         where i.contract_id = ${contractId}
         group by i.id, i.installment_number, i.due_date, i.amount_minor_units
         order by i.installment_number
      `);
      return result.rows.map((row) => ({
        id: row.id,
        installmentNumber: row.installment_number,
        dueDate: String(row.due_date),
        amountMinor: BigInt(row.amount_minor_units),
        postedMinor: BigInt(row.posted_minor),
      }));
    },

    async insertNotification(input: typeof notification.$inferInsert) {
      const [row] = await executor
        .insert(notification)
        .values(input)
        .onConflictDoNothing({ target: notification.idempotencyKey })
        .returning();
      if (row !== undefined) return { row, inserted: true } as const;
      const [existing] = await executor
        .select()
        .from(notification)
        .where(eq(notification.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing === undefined) throw new Error("NOTIFICATION_DEDUP_FAILED");
      return { row: existing, inserted: false } as const;
    },

    async listCustomerNotifications(personId: string) {
      const result = await executor.execute<{
        id: string;
        template: string;
        status: string;
        created_at: Date | string;
        updated_at: Date | string;
      }>(sql`
        select n.id, n.template, n.status, n.created_at, n.updated_at
          from notification n
          join contract c on c.id::text = n.payload->>'contractId'
          join application a on a.id = c.application_id
         where a.applicant_person_id = ${personId}
         order by n.created_at desc, n.id desc
      `);
      return result.rows;
    },

    async listNotifications() {
      return executor
        .select({
          id: notification.id,
          template: notification.template,
          status: notification.status,
          createdAt: notification.createdAt,
          updatedAt: notification.updatedAt,
        })
        .from(notification)
        .orderBy(asc(notification.createdAt));
    },

    async findNotificationDeliveryContext(notificationId: string) {
      const [row] = await executor
        .select()
        .from(notification)
        .where(eq(notification.id, notificationId))
        .limit(1);
      if (row === undefined) return null;
      const payload = row.payload;
      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
      )
        return null;
      const candidate = payload as Record<string, unknown>;
      const contractId = candidate.contractId;
      const template = candidate.template;
      const variables = candidate.variables;
      if (
        typeof contractId !== "string" ||
        typeof template !== "string" ||
        typeof variables !== "object" ||
        variables === null ||
        Array.isArray(variables) ||
        Object.values(variables).some((value) => typeof value !== "string")
      )
        return null;
      const context = await executor.execute<{ phone_e164: string }>(sql`
        select p.phone_e164
          from contract c
          join application a on a.id = c.application_id
          join privacy.person p on p.id = a.applicant_person_id
         where c.id::text = ${contractId}
         limit 1
      `);
      const phoneE164 = context.rows[0]?.phone_e164;
      if (phoneE164 === undefined) return null;
      const attempts = await executor
        .select({ id: deliveryAttempt.id })
        .from(deliveryAttempt)
        .where(eq(deliveryAttempt.notificationId, notificationId));
      return {
        notificationId,
        phoneE164,
        template: template as
          "PAYMENT_DUE" | "PAYMENT_WARNING" | "ARREARS_WARNING",
        variables: variables as Record<string, string>,
        status: row.status,
        nextAttemptNumber: attempts.length + 1,
      };
    },

    async recordNotificationDeliveryAttempt(input: {
      notificationId: string;
      attemptNumber: number;
      provider: string;
      providerReference: string;
      response: Record<string, unknown>;
      status: "SENT";
    }) {
      await executor
        .insert(deliveryAttempt)
        .values({
          notificationId: input.notificationId,
          provider: input.provider,
          providerReference: input.providerReference,
          attemptNumber: input.attemptNumber,
          response: input.response,
          attemptedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [
            deliveryAttempt.notificationId,
            deliveryAttempt.attemptNumber,
          ],
        });
      await executor
        .update(notification)
        .set({
          status: input.status,
          version: sql`${notification.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(notification.id, input.notificationId));
    },

    async saveArrearsSnapshot(input: {
      contractId: string;
      asOfDate: string;
      overdueMinorUnits: bigint;
      unpaidInstallments: number;
      consecutiveMissedInstallments: number;
    }) {
      const [row] = await executor
        .insert(arrearsSnapshot)
        .values(input)
        .onConflictDoUpdate({
          target: [arrearsSnapshot.contractId, arrearsSnapshot.asOfDate],
          set: {
            overdueMinorUnits: input.overdueMinorUnits,
            unpaidInstallments: input.unpaidInstallments,
            consecutiveMissedInstallments: input.consecutiveMissedInstallments,
          },
        })
        .returning();
      if (row === undefined) throw new Error("ARREARS_SNAPSHOT_SAVE_FAILED");
      return row;
    },

    async insertArrearsEscalation(input: {
      contractId: string;
      asOfDate: string;
      signal: "THREE_CONSECUTIVE_MISSED" | "THREE_TOTAL_UNPAID";
      overdueMinorUnits: bigint;
      unpaidInstallments: number;
      consecutiveMissedInstallments: number;
    }) {
      const [row] = await executor
        .insert(arrearsEscalation)
        .values(input)
        .onConflictDoNothing({
          target: [
            arrearsEscalation.contractId,
            arrearsEscalation.asOfDate,
            arrearsEscalation.signal,
          ],
        })
        .returning();
      return row ?? null;
    },

    async listArrearsSignals(contractId: string) {
      return executor
        .select()
        .from(arrearsEscalation)
        .where(eq(arrearsEscalation.contractId, contractId))
        .orderBy(
          desc(arrearsEscalation.asOfDate),
          asc(arrearsEscalation.signal),
        );
    },

    async findContractContext(
      contractId: string,
    ): Promise<CollectionContractContext | null> {
      const result = await executor.execute<{
        contract_id: string;
        reference: string;
        applicant_person_id: string;
        phone_e164: string;
        vehicle_unit_id: string;
        status: string;
        outstanding_balance_minor_units: bigint | string;
      }>(sql`
        select c.id as contract_id,
               c.reference,
               a.applicant_person_id,
               p.phone_e164,
               c.vehicle_unit_id,
               c.status,
               c.outstanding_balance_minor_units
          from contract c
          join application a on a.id = c.application_id
          join privacy.person p on p.id = a.applicant_person_id
         where c.id = ${contractId}
         limit 1
      `);
      const row = result.rows[0];
      if (row === undefined) return null;
      return {
        contractId: row.contract_id,
        reference: row.reference,
        applicantPersonId: row.applicant_person_id,
        phoneE164: row.phone_e164,
        vehicleUnitId: row.vehicle_unit_id,
        status: row.status,
        outstandingBalanceMinorUnits: BigInt(
          row.outstanding_balance_minor_units,
        ),
      };
    },

    async listCustomerAccounts(personId: string) {
      const result = await executor.execute<{
        contract_id: string;
        reference: string;
        status: string;
        outstanding_balance_minor_units: bigint | string;
        next_due_date: string | null;
        overdue_minor_units: bigint | string;
        unpaid_installments: number;
        consecutive_missed_installments: number;
      }>(sql`
        select c.id as contract_id,
               c.reference,
               c.status,
               c.outstanding_balance_minor_units,
               (select i.due_date from installment i
                 where i.contract_id = c.id and i.status <> 'PAID'
                 order by i.installment_number limit 1) as next_due_date,
               coalesce((select s.overdue_minor_units from arrears_snapshot s
                  where s.contract_id = c.id order by s.as_of_date desc limit 1), 0)::bigint as overdue_minor_units,
               coalesce((select s.unpaid_installments from arrears_snapshot s
                  where s.contract_id = c.id order by s.as_of_date desc limit 1), 0)::int as unpaid_installments,
               coalesce((select s.consecutive_missed_installments from arrears_snapshot s
                  where s.contract_id = c.id order by s.as_of_date desc limit 1), 0)::int as consecutive_missed_installments
          from contract c
          join application a on a.id = c.application_id
         where a.applicant_person_id = ${personId}
         order by c.created_at desc
      `);
      return result.rows.map((row) => ({
        contractId: row.contract_id,
        reference: row.reference,
        status: row.status,
        outstandingBalanceMinorUnits: String(
          row.outstanding_balance_minor_units,
        ),
        nextDueDate: row.next_due_date,
        overdueMinorUnits: String(row.overdue_minor_units),
        unpaidInstallments: row.unpaid_installments,
        consecutiveMissedInstallments: row.consecutive_missed_installments,
      }));
    },

    async listArrearsQueue() {
      const result = await executor.execute<Record<string, unknown>>(sql`
        with latest_snapshot as (
          select distinct on (s.contract_id)
                 s.contract_id, s.as_of_date, s.overdue_minor_units,
                 s.unpaid_installments, s.consecutive_missed_installments
            from arrears_snapshot s
           order by s.contract_id, s.as_of_date desc
        )
        select coalesce(e.id, c.id) as id,
               c.id as contract_id, c.reference, c.status,
               c.outstanding_balance_minor_units,
               ls.as_of_date,
               coalesce(ls.overdue_minor_units, 0)::bigint as overdue_minor_units,
               coalesce(ls.unpaid_installments, 0)::int as unpaid_installments,
               coalesce(ls.consecutive_missed_installments, 0)::int as consecutive_missed_installments,
               e.signal
          from contract c
          join application a on a.id = c.application_id
          left join latest_snapshot ls on ls.contract_id = c.id
          left join arrears_escalation e
            on e.contract_id = c.id and e.as_of_date = ls.as_of_date
         where c.status in ('ACTIVE', 'RECOVERY')
           and (ls.contract_id is not null or e.id is not null)
         order by overdue_minor_units desc, c.id, e.signal
      `);
      return result.rows.map((row) => ({
        id: String(row.id),
        contractId: String(row.contract_id),
        reference: String(row.reference),
        status: String(row.status),
        outstandingBalanceMinorUnits: String(
          row.outstanding_balance_minor_units,
        ),
        asOfDate: row.as_of_date === null ? null : String(row.as_of_date),
        overdueMinorUnits: String(row.overdue_minor_units),
        unpaidCount: Number(row.unpaid_installments),
        consecutiveMissedCount: Number(row.consecutive_missed_installments),
        signal: row.signal === null ? null : String(row.signal),
      }));
    },

    async insertRecoveryCase(input: {
      id: string;
      contractId: string;
      openedAt: Date;
      details: Record<string, unknown>;
      assignedOfficerId?: string;
    }) {
      const [row] = await executor
        .insert(recoveryCase)
        .values({
          id: input.id,
          contractId: input.contractId,
          status: "OPEN",
          details: input.details,
          ...(input.assignedOfficerId === undefined
            ? {}
            : { assignedOfficerId: input.assignedOfficerId }),
          openedAt: input.openedAt,
        })
        .returning();
      if (row === undefined) throw new Error("RECOVERY_CASE_CREATE_FAILED");
      return row;
    },

    async findRecoveryCase(caseId: string, lock = false) {
      const query = executor
        .select()
        .from(recoveryCase)
        .where(eq(recoveryCase.id, caseId));
      const locked = lock ? query.for("update") : query;
      const [row] = await locked.limit(1);
      return row ?? null;
    },

    async findRecoveryCaseByContract(contractId: string) {
      const [row] = await executor
        .select()
        .from(recoveryCase)
        .where(
          and(
            eq(recoveryCase.contractId, contractId),
            sql`${recoveryCase.status} <> 'CLOSED'`,
          ),
        )
        .orderBy(desc(recoveryCase.openedAt))
        .limit(1);
      return row ?? null;
    },

    async findRecoveryDecisionByKey(idempotencyKey: string) {
      const [row] = await executor
        .select()
        .from(recoveryDecision)
        .where(eq(recoveryDecision.idempotencyKey, idempotencyKey))
        .limit(1);
      return row ?? null;
    },

    async findRecoveryDecisionByCase(caseId: string) {
      const [row] = await executor
        .select()
        .from(recoveryDecision)
        .where(eq(recoveryDecision.recoveryCaseId, caseId))
        .orderBy(desc(recoveryDecision.decidedAt))
        .limit(1);
      return row ?? null;
    },

    async findApprovedRecoveryDecision(caseId: string) {
      const [row] = await executor
        .select()
        .from(recoveryDecision)
        .where(
          and(
            eq(recoveryDecision.recoveryCaseId, caseId),
            eq(recoveryDecision.decision, "APPROVED"),
          ),
        )
        .orderBy(desc(recoveryDecision.decidedAt))
        .limit(1);
      return row ?? null;
    },

    async listRecoveryCases() {
      return executor
        .select()
        .from(recoveryCase)
        .orderBy(desc(recoveryCase.openedAt));
    },

    async listRecoveryDecisions(caseId: string) {
      return executor
        .select()
        .from(recoveryDecision)
        .where(eq(recoveryDecision.recoveryCaseId, caseId))
        .orderBy(asc(recoveryDecision.decidedAt));
    },

    async listRecoveryActions(caseId: string) {
      return executor
        .select()
        .from(recoveryAction)
        .where(eq(recoveryAction.recoveryCaseId, caseId))
        .orderBy(asc(recoveryAction.createdAt));
    },

    async findRecoveryActionByKey(idempotencyKey: string) {
      const [row] = await executor
        .select()
        .from(recoveryAction)
        .where(eq(recoveryAction.idempotencyKey, idempotencyKey))
        .limit(1);
      return row ?? null;
    },

    async updateRecoveryCase(
      id: string,
      values: Partial<typeof recoveryCase.$inferInsert>,
    ) {
      const [row] = await executor
        .update(recoveryCase)
        .set({ ...values, version: sql`${recoveryCase.version} + 1` })
        .where(eq(recoveryCase.id, id))
        .returning();
      if (row === undefined) throw new Error("RECOVERY_CASE_UPDATE_FAILED");
      return row;
    },

    async insertRecoveryDecision(input: typeof recoveryDecision.$inferInsert) {
      const [row] = await executor
        .insert(recoveryDecision)
        .values(input)
        .onConflictDoNothing({ target: recoveryDecision.idempotencyKey })
        .returning();
      if (row !== undefined) return { row, inserted: true } as const;
      const existing = await this.findRecoveryDecisionByKey(
        input.idempotencyKey,
      );
      if (existing === null) throw new Error("RECOVERY_DECISION_DEDUP_FAILED");
      return { row: existing, inserted: false } as const;
    },

    async insertRecoveryAction(input: typeof recoveryAction.$inferInsert) {
      const [row] = await executor
        .insert(recoveryAction)
        .values(input)
        .onConflictDoNothing({
          target: recoveryAction.idempotencyKey,
          where: sql`${recoveryAction.idempotencyKey} is not null`,
        })
        .returning();
      if (row !== undefined) return { row, inserted: true } as const;
      const existing =
        input.idempotencyKey === null || input.idempotencyKey === undefined
          ? null
          : await this.findRecoveryActionByKey(input.idempotencyKey);
      if (existing === null) throw new Error("RECOVERY_ACTION_CREATE_FAILED");
      return { row: existing, inserted: false } as const;
    },

    async insertRecoveryLocationLookup(
      input: typeof recoveryLocationLookup.$inferInsert,
    ) {
      const [row] = await executor
        .insert(recoveryLocationLookup)
        .values(input)
        .returning();
      if (row === undefined) throw new Error("RECOVERY_LOCATION_AUDIT_FAILED");
      return row;
    },

    async findTrackerForRecoveryCase(caseId: string) {
      const result = await executor.execute<{
        recovery_case_id: string;
        contract_id: string;
        tracker_id: string | null;
        status: string;
      }>(sql`
        select rc.id as recovery_case_id, rc.contract_id,
               vu.tracker_identifier as tracker_id, rc.status
          from recovery_case rc
          join contract c on c.id = rc.contract_id
          join vehicle_unit vu on vu.id = c.vehicle_unit_id
         where rc.id = ${caseId}
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async insertSettlementApproval(
      input: typeof settlementApproval.$inferInsert,
    ) {
      const [row] = await executor
        .insert(settlementApproval)
        .values(input)
        .onConflictDoNothing({ target: settlementApproval.idempotencyKey })
        .returning();
      if (row !== undefined) return { row, inserted: true } as const;
      const [existing] = await executor
        .select()
        .from(settlementApproval)
        .where(eq(settlementApproval.idempotencyKey, input.idempotencyKey))
        .limit(1);
      if (existing === undefined)
        throw new Error("SETTLEMENT_APPROVAL_DEDUP_FAILED");
      return { row: existing, inserted: false } as const;
    },

    async findSettlementApprovals(contractId: string) {
      return executor
        .select()
        .from(settlementApproval)
        .where(eq(settlementApproval.contractId, contractId));
    },

    async findSettlementApproval(
      contractId: string,
      approvalType: string,
      bundleDigest?: string,
    ) {
      const [row] = await executor
        .select()
        .from(settlementApproval)
        .where(
          and(
            eq(settlementApproval.contractId, contractId),
            eq(settlementApproval.approvalType, approvalType),
            ...(bundleDigest === undefined
              ? []
              : [eq(settlementApproval.bundleDigest, bundleDigest)]),
          ),
        )
        .orderBy(
          desc(settlementApproval.approvedAt),
          desc(settlementApproval.id),
        )
        .limit(1);
      return row ?? null;
    },

    async insertSettlementEvidence(
      input: typeof settlementEvidence.$inferInsert,
    ) {
      const [row] = await executor
        .insert(settlementEvidence)
        .values(input)
        .onConflictDoNothing({
          target: settlementEvidence.contractId,
          where: sql`${settlementEvidence.verificationStatus} = 'CLEAN'`,
        })
        .returning();
      if (row !== undefined) return { row, inserted: true } as const;
      const [existing] = await executor
        .select()
        .from(settlementEvidence)
        .where(
          and(
            eq(settlementEvidence.contractId, input.contractId),
            eq(settlementEvidence.verificationStatus, "CLEAN"),
          ),
        )
        .limit(1);
      if (existing === undefined)
        throw new Error("SETTLEMENT_EVIDENCE_DEDUP_FAILED");
      return { row: existing, inserted: false } as const;
    },

    async findSettlementEvidenceDocument(
      contractId: string,
      documentId: string,
    ) {
      const result = await executor.execute<{
        document_id: string;
        person_id: string;
        object_key: string | null;
        accepted_object_key: string | null;
        accepted_object_version_id: string | null;
        accepted_object_etag: string | null;
        sha256: string | null;
        status: string;
        malware_scanned: boolean;
      }>(sql`
        select d.id as document_id,
               d.person_id,
               d.object_key,
               d.accepted_object_key,
               d.accepted_object_version_id,
               d.accepted_object_etag,
               d.sha256,
               d.status,
               d.malware_scanned
          from contract c
          join application a on a.id = c.application_id
          join privacy.document d on d.person_id = a.applicant_person_id
         where c.id = ${contractId}
           and d.id = ${documentId}::uuid
           and d.document_type = 'TRANSFER_EVIDENCE'
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async findSettlementEvidence(contractId: string) {
      const [row] = await executor
        .select()
        .from(settlementEvidence)
        .where(
          and(
            eq(settlementEvidence.contractId, contractId),
            eq(settlementEvidence.verificationStatus, "CLEAN"),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async settlementGate(contractId: string) {
      await executor.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended('somo:settlement-reconciliation', 0)
        )
      `);
      const result = await executor.execute<{
        contract_status: string;
        balance: bigint | string;
        unresolved_reconciliation: boolean;
        unresolved_payment: boolean;
        reversed_payment: boolean;
      }>(sql`
        select c.status as contract_status,
               c.outstanding_balance_minor_units as balance,
               exists (
                select 1 from reconciliation_case rc
                 left join payment_transaction pt on pt.id = rc.payment_transaction_id
                where rc.status <> 'RESOLVED'
                  and (rc.contract_id = c.id or pt.contract_id = c.id)
               ) as unresolved_reconciliation,
               exists (
                 select 1 from payment_transaction pt
                where pt.contract_id = c.id and pt.status in ('RECEIVED', 'MATCHED')
               ) as unresolved_payment,
               exists (
                 select 1 from reconciliation_case rc
                 left join payment_transaction pt on pt.id = rc.payment_transaction_id
                where rc.status <> 'RESOLVED'
                  and (rc.contract_id = c.id or pt.contract_id = c.id)
                  and rc.reason in (
                    'PAYMENT_REVERSAL_REQUIRES_EXCEPTION',
                    'POST_SETTLEMENT_REVERSAL_REQUIRES_EXCEPTION'
                  )
               ) as reversed_payment
          from contract c
         where c.id = ${contractId}
         for update
      `);
      return result.rows[0] ?? null;
    },

    async settlementApprovalSnapshot(contractId: string) {
      const result = await executor.execute<{
        contract_status: string;
        contract_version: number;
        balance: string;
        ledger_head_id: string | null;
        ledger_state: unknown;
        reconciliation_state: unknown;
        payment_state: unknown;
      }>(sql`
        select c.status::text as contract_status,
               c.version as contract_version,
               c.outstanding_balance_minor_units::text as balance,
               (select l.id
                  from ledger_entry l
                 where l.contract_id = c.id
                 order by l.occurred_at desc, l.created_at desc, l.id desc
                 limit 1) as ledger_head_id,
               coalesce((
                 select jsonb_agg(
                   jsonb_build_array(
                     l.id, l.posting_key, l.entry_type, l.direction,
                     l.amount_minor_units::text,
                     l.balance_after_minor_units::text,
                     l.reverses_entry_id, l.occurred_at
                   ) order by l.occurred_at, l.created_at, l.id
                 )
                   from ledger_entry l
                  where l.contract_id = c.id
               ), '[]'::jsonb) as ledger_state,
               coalesce((
                 select jsonb_agg(
                   jsonb_build_array(
                     rc.id, rc.status, rc.version, rc.reason,
                     rc.resolution, rc.updated_at
                   ) order by rc.created_at, rc.id
                 )
                   from reconciliation_case rc
                   left join payment_transaction related
                     on related.id = rc.payment_transaction_id
                  where rc.contract_id = c.id
                     or related.contract_id = c.id
               ), '[]'::jsonb) as reconciliation_state,
               coalesce((
                 select jsonb_agg(
                   jsonb_build_array(
                     pt.id, pt.provider_transaction_id, pt.event_id,
                     pt.event_type, pt.status, pt.version,
                     pt.amount_minor_units::text, pt.updated_at
                   ) order by pt.created_at, pt.id
                 )
                   from payment_transaction pt
                  where pt.contract_id = c.id
               ), '[]'::jsonb) as payment_state
          from contract c
         where c.id = ${contractId}
         for update
      `);
      return result.rows[0] ?? null;
    },

    async lockContractAggregate(contractId: string) {
      await executor.execute(sql`
        select pg_advisory_xact_lock(
          hashtextextended(${contractId}::text, 9137)
        )
      `);
    },

    async findSettlementWorkflow(contractId: string, lock = false) {
      const query = executor
        .select()
        .from(settlementWorkflow)
        .where(eq(settlementWorkflow.contractId, contractId));
      const locked = lock ? query.for("update") : query;
      const [row] = await locked.limit(1);
      return row ?? null;
    },

    async createSettlementWorkflow(contractId: string) {
      const [row] = await executor
        .insert(settlementWorkflow)
        .values({ contractId })
        .onConflictDoNothing({ target: settlementWorkflow.contractId })
        .returning();
      if (row !== undefined) return row;
      const existing = await this.findSettlementWorkflow(contractId);
      if (existing === null)
        throw new Error("SETTLEMENT_WORKFLOW_CREATE_FAILED");
      return existing;
    },

    async updateSettlementWorkflow(
      id: string,
      values: Partial<typeof settlementWorkflow.$inferInsert>,
    ) {
      const [row] = await executor
        .update(settlementWorkflow)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(settlementWorkflow.id, id))
        .returning();
      if (row === undefined)
        throw new Error("SETTLEMENT_WORKFLOW_UPDATE_FAILED");
      return row;
    },

    async markContractSettled(contractId: string, settledAt: Date) {
      const result = await executor.execute<{ id: string }>(sql`
        update contract
           set status = 'SETTLED',
               settled_at = ${settledAt},
               updated_at = ${settledAt},
               version = version + 1
         where id = ${contractId}
           and status = 'ACTIVE'
           and outstanding_balance_minor_units = 0
         returning id
      `);
      return result.rows.length === 1;
    },

    async completeOwnershipTransfer(input: {
      contractId: string;
      approvedBy: string;
      evidence: Record<string, unknown> & {
        registrationEvidenceDocumentId: string;
      };
      transferredAt: Date;
    }) {
      const existing = await executor
        .select()
        .from(ownershipTransfer)
        .where(eq(ownershipTransfer.contractId, input.contractId))
        .for("update");
      const transfer = existing[0];
      const authoritative = await executor.execute<{
        contract_status: string;
        ownership_holder: string;
        outstanding_balance_minor_units: bigint | string;
        vehicle_unit_id: string;
        vehicle_status: string;
        registration_number: string | null;
        registered_owner: string | null;
        valid_from: string | null;
        valid_to: string | null;
        registration_evidence_document_id: string | null;
      }>(sql`
        select agreement.status::text as contract_status,
               agreement.ownership_holder,
               agreement.outstanding_balance_minor_units,
               asset.id as vehicle_unit_id,
               asset.status::text as vehicle_status,
               registration.registration_number,
               registration.registered_owner::text,
               registration.valid_from::text,
               registration.valid_to::text,
               registration.evidence_document_id::text
                 as registration_evidence_document_id
          from contract agreement
          join vehicle_unit asset on asset.id = agreement.vehicle_unit_id
          left join lateral (
            select record.registration_number, record.registered_owner,
                   record.valid_from, record.valid_to,
                   record.evidence_document_id
              from registration_record record
             where record.vehicle_unit_id = asset.id
             order by record.created_at desc, record.id desc
             limit 1
          ) registration on true
         where agreement.id = ${input.contractId}
         for update of agreement, asset
      `);
      const state = authoritative.rows[0];
      if (state === undefined) throw new Error("CONTRACT_NOT_FOUND");

      if (transfer?.status === "COMPLETED") {
        const requestedEvidenceDocumentId =
          input.evidence.registrationEvidenceDocumentId;
        const transferEvidenceDocumentId =
          typeof transfer.evidence?.registrationEvidenceDocumentId === "string"
            ? transfer.evidence.registrationEvidenceDocumentId
            : null;
        const evidenceDocument = isUuid(requestedEvidenceDocumentId)
          ? await executor.execute<{
              document_type: string;
              status: string;
              malware_scanned: boolean;
              sha256: string | null;
              accepted_object_key: string | null;
              accepted_object_version_id: string | null;
              accepted_object_etag: string | null;
            }>(sql`
              select document.document_type,
                     document.status::text,
                     document.malware_scanned,
                     document.sha256,
                     document.accepted_object_key,
                     document.accepted_object_version_id,
                     document.accepted_object_etag
                from contract agreement
                join application on application.id = agreement.application_id
                join privacy.document document
                  on document.id = ${requestedEvidenceDocumentId}::uuid
                 and document.person_id = application.applicant_person_id
               where agreement.id = ${input.contractId}
            `)
          : { rows: [] };
        const document = evidenceDocument.rows[0];
        const acceptedEvidence =
          document !== undefined &&
          document.document_type === "TRANSFER_EVIDENCE" &&
          document.status === "ACCEPTED" &&
          document.malware_scanned &&
          typeof document.sha256 === "string" &&
          /^[0-9a-f]{64}$/.test(document.sha256) &&
          typeof document.accepted_object_key === "string" &&
          document.accepted_object_key.length > 0 &&
          typeof document.accepted_object_version_id === "string" &&
          document.accepted_object_version_id.length > 0 &&
          typeof document.accepted_object_etag === "string" &&
          document.accepted_object_etag.length > 0;
        const coherent =
          acceptedEvidence &&
          transfer?.approvedBy !== null &&
          transfer?.approvedBy !== undefined &&
          transferEvidenceDocumentId === requestedEvidenceDocumentId &&
          state.contract_status === "TRANSFERRED" &&
          state.ownership_holder === "CUSTOMER" &&
          BigInt(state.outstanding_balance_minor_units) === 0n &&
          state.vehicle_status === "TRANSFERRED" &&
          state.registration_number !== null &&
          state.registered_owner === "CUSTOMER" &&
          state.valid_from !== null &&
          state.registration_evidence_document_id ===
            requestedEvidenceDocumentId;
        if (coherent) return transfer;

        const derivable =
          acceptedEvidence &&
          transfer?.approvedBy !== null &&
          transfer?.approvedBy !== undefined &&
          transferEvidenceDocumentId === requestedEvidenceDocumentId &&
          state.contract_status === "SETTLED" &&
          state.ownership_holder === "SOMOCO" &&
          BigInt(state.outstanding_balance_minor_units) === 0n &&
          state.registration_number !== null &&
          state.registered_owner === "SOMOCO" &&
          state.valid_from !== null &&
          (state.registration_evidence_document_id === null ||
            state.registration_evidence_document_id ===
              requestedEvidenceDocumentId);
        if (!derivable)
          throw new Error(
            "LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED",
          );

        const contractTransition = await executor.execute(sql`
          update contract
             set status = 'TRANSFERRED', ownership_holder = 'CUSTOMER',
                 version = version + 1, updated_at = ${input.transferredAt}
           where id = ${input.contractId}
             and status = 'SETTLED' and ownership_holder = 'SOMOCO'
             and outstanding_balance_minor_units = 0
        `);
        if ((contractTransition.rowCount ?? 0) !== 1)
          throw new Error(
            "LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED",
          );
        if (state.vehicle_status !== "TRANSFERRED") {
          const vehicleTransition = await executor.execute(sql`
            update vehicle_unit
               set status = 'TRANSFERRED', version = version + 1,
                   updated_at = ${input.transferredAt}
             where id = ${state.vehicle_unit_id}
               and status <> 'TRANSFERRED'
          `);
          if ((vehicleTransition.rowCount ?? 0) !== 1)
            throw new Error(
              "LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED",
            );
        }
        await executor.execute(sql`
          insert into registration_record
            (vehicle_unit_id, registration_number, registered_owner,
             valid_from, valid_to, evidence_document_id, created_at)
          values (${state.vehicle_unit_id}, ${state.registration_number}, 'CUSTOMER',
                  ${state.valid_from}::date, ${state.valid_to}::date,
                  ${requestedEvidenceDocumentId}::uuid,
                  greatest(now(), ${input.transferredAt}))
        `);
        return transfer;
      }
      if (
        state.contract_status !== "SETTLED" ||
        state.ownership_holder !== "SOMOCO" ||
        BigInt(state.outstanding_balance_minor_units) !== 0n
      )
        throw new Error("CONTRACT_NOT_SETTLED");
      if (
        state.registration_number === null ||
        state.registered_owner !== "SOMOCO" ||
        state.valid_from === null
      )
        throw new Error("REGISTRATION_TRANSFER_EVIDENCE_REQUIRED");

      const contractTransition = await executor.execute(sql`
        update contract
           set status = 'TRANSFERRED', ownership_holder = 'CUSTOMER',
               version = version + 1, updated_at = ${input.transferredAt}
         where id = ${input.contractId}
           and status = 'SETTLED' and ownership_holder = 'SOMOCO'
           and outstanding_balance_minor_units = 0
      `);
      if ((contractTransition.rowCount ?? 0) !== 1)
        throw new Error("OWNERSHIP_TRANSFER_CONFLICT");
      const vehicleTransition = await executor.execute(sql`
        update vehicle_unit
           set status = 'TRANSFERRED', version = version + 1,
               updated_at = ${input.transferredAt}
         where id = ${state.vehicle_unit_id}
           and status <> 'TRANSFERRED'
      `);
      if ((vehicleTransition.rowCount ?? 0) !== 1)
        throw new Error("OWNERSHIP_TRANSFER_CONFLICT");
      await executor.execute(sql`
        insert into registration_record
          (vehicle_unit_id, registration_number, registered_owner,
           valid_from, valid_to, evidence_document_id, created_at)
        values (${state.vehicle_unit_id}, ${state.registration_number}, 'CUSTOMER',
                ${state.valid_from}::date, ${state.valid_to}::date,
                ${input.evidence.registrationEvidenceDocumentId}::uuid,
                ${input.transferredAt})
      `);
      if (transfer === undefined) {
        const [inserted] = await executor
          .insert(ownershipTransfer)
          .values({
            contractId: input.contractId,
            status: "COMPLETED",
            approvedBy: input.approvedBy,
            evidence: input.evidence,
            transferredAt: input.transferredAt,
            version: 1,
            updatedAt: input.transferredAt,
          })
          .returning();
        if (inserted === undefined)
          throw new Error("OWNERSHIP_TRANSFER_CREATE_FAILED");
        return inserted;
      }
      const [updated] = await executor
        .update(ownershipTransfer)
        .set({
          status: "COMPLETED",
          approvedBy: input.approvedBy,
          evidence: input.evidence,
          transferredAt: input.transferredAt,
          updatedAt: input.transferredAt,
          version: transfer.version + 1,
        })
        .where(eq(ownershipTransfer.id, transfer.id))
        .returning();
      if (updated === undefined)
        throw new Error("OWNERSHIP_TRANSFER_UPDATE_FAILED");
      return updated;
    },

    async enqueueSettlementEvent(message: NewOutboxMessage) {
      const [row] = await executor
        .insert(outboxMessage)
        .values({ ...message, availableAt: message.occurredAt })
        .onConflictDoNothing({
          target: [outboxMessage.topic, outboxMessage.aggregateId],
          where: sql`${outboxMessage.topic} in ('ContractSettled', 'OwnershipTransferred')`,
        })
        .returning({ id: outboxMessage.id });
      return row !== undefined;
    },
  };
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
