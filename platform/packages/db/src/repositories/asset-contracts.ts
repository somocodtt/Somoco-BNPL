import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  getInternalExecutor,
  type DatabaseTransaction,
} from "../transaction.js";

export interface AssetContractCommandRecord {
  id: string;
  scope: string;
  idempotencyKey: string;
  commandType: string;
  payloadHash: string;
  actorStaffUserId: string | null;
  actorPersonId: string | null;
  applicationId: string | null;
  contractId: string | null;
  response: Record<string, unknown>;
  inserted?: boolean;
}

export interface VehicleRow extends Record<string, unknown> {
  id: string;
  vehicle_model_id: string;
  vin: string;
  chassis_number: string;
  engine_motor_identifier: string | null;
  condition: Record<string, unknown>;
  accessories: string[];
  tracker_identifier: string | null;
  registration_number: string | null;
  status: string;
  version: number;
}

export interface AssignmentRow extends Record<string, unknown> {
  id: string;
  application_id: string;
  vehicle_unit_id: string;
  offer_id: string | null;
  offer_version_id: string | null;
  deposit_reconciled_amount_minor_units: bigint | string | null;
  deposit_evidence_id: string | null;
  supersedes_assignment_id: string | null;
  reassignment_approved_by: string | null;
  reassignment_reason: string | null;
  assigned_by: string;
  assigned_at: Date | string;
  released_at: Date | string | null;
  version: number;
}

export interface ApplicationRow extends Record<string, unknown> {
  id: string;
  applicant_person_id: string;
  guarantor_person_id: string | null;
  vehicle_model_id: string | null;
  status: string;
  version: number;
}

export interface OfferRow extends Record<string, unknown> {
  id: string;
  application_id: string;
  status: string;
  version: number;
  expires_at: Date | string | null;
  accepted_version_id: string | null;
  accepted_hash: string | null;
  offer_version_id: string | null;
  offer_version_number: number | null;
  offer_financing_rule_version_id: string | null;
  principal_minor_units: bigint | string | null;
  deposit_minor_units: bigint | string | null;
  total_payable_minor_units: bigint | string | null;
  terms: Record<string, unknown> | null;
  canonical_hash: string | null;
}

export interface ContractRow extends Record<string, unknown> {
  id: string;
  reference: string;
  application_id: string;
  offer_version_id: string;
  template_version_id: string | null;
  vehicle_unit_id: string;
  status: string;
  canonical_hash: string | null;
  preview_reference: string | null;
  ownership_holder: string;
  outstanding_balance_minor_units: bigint | string;
  version: number;
  activated_at: Date | string | null;
  generated_at: Date | string | null;
}

export interface ExecutionRow extends Record<string, unknown> {
  id: string;
  contract_id: string;
  version_number: number;
  applicant_person_id: string | null;
  guarantor_person_id: string | null;
  staff_witness_id: string;
  execution_date: Date | string;
  head_office_location: string;
  executed_document_id: string;
  executed_document_hash: string;
  authorization_reason: string | null;
}

export interface HandoverRow extends Record<string, unknown> {
  id: string;
  contract_id: string;
  checklist: Record<string, unknown>;
  checklist_version: string;
  customer_acknowledged_at: Date | string | null;
  customer_acknowledged_by_person_id: string | null;
  head_office_id: string | null;
  condition: Record<string, unknown>;
  accessories: Record<string, unknown>;
  head_office_location: string;
  handed_over_by: string;
  handed_over_at: Date | string;
  version: number;
}

export interface HandoverAcknowledgementRow extends Record<string, unknown> {
  id: string;
  contract_id: string;
  application_id: string;
  person_id: string;
  customer_account_id: string;
  customer_session_id: string;
  checklist_version: string;
  checklist_hash: string;
  acknowledged_at: Date | string;
  idempotency_key: string;
}

export interface ReassignmentApprovalRow extends Record<string, unknown> {
  id: string;
  application_id: string;
  previous_assignment_id: string;
  requested_vehicle_unit_id: string;
  contract_id: string | null;
  requested_by: string;
  requested_by_role: string;
  approved_by: string | null;
  approved_by_role: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED";
  reason: string;
  effective_from: Date | string;
  effective_until: Date | string | null;
  approved_at: Date | string | null;
  created_at: Date | string;
}

export interface TemplateRow extends Record<string, unknown> {
  id: string;
  template_key: string;
  version_number: number;
  content_hash: string;
  approved_pdf_hash: string;
  approved_by: string;
  approved_at: Date | string;
  effective_from: Date | string;
  effective_until: Date | string | null;
  published_at: Date | string;
  attestation_mode: "PRODUCTION" | "TEST";
}

export interface DepositRow extends Record<string, unknown> {
  id: string;
  application_id: string;
  offer_id: string;
  amount_minor_units: bigint | string;
  currency: string;
  status: string;
  reconciled_at: Date | string | null;
  evidence_hash: string;
}

export function assetContractRepo(db: Database | DatabaseTransaction) {
  const executor = getInternalExecutor(db);
  return {
    async findCommand(
      scope: string,
      idempotencyKey: string,
    ): Promise<AssetContractCommandRecord | null> {
      const result = await executor.execute<AssetContractCommandRow>(sql`
        select id, scope, idempotency_key, command_type, payload_hash,
               actor_staff_user_id, actor_person_id, application_id, contract_id, response
          from asset_contract_command
         where scope = ${scope} and idempotency_key = ${idempotencyKey}
         limit 1
      `);
      return result.rows[0] === undefined ? null : mapCommand(result.rows[0]);
    },

    async insertCommand(input: {
      scope: string;
      idempotencyKey: string;
      commandType: string;
      payloadHash: string;
      actorStaffUserId?: string;
      actorPersonId?: string;
      applicationId?: string;
      contractId?: string;
      response: Record<string, unknown>;
    }): Promise<AssetContractCommandRecord> {
      const result = await executor.execute<AssetContractCommandRow>(sql`
        insert into asset_contract_command
          (scope, idempotency_key, command_type, payload_hash,
           actor_staff_user_id, actor_person_id, application_id, contract_id, response)
        values (${input.scope}, ${input.idempotencyKey}, ${input.commandType}, ${input.payloadHash},
                ${input.actorStaffUserId ?? null}::uuid, ${input.actorPersonId ?? null}::uuid,
                ${input.applicationId ?? null}::uuid, ${input.contractId ?? null}::uuid,
                ${JSON.stringify(input.response)}::jsonb)
        on conflict (scope, idempotency_key) do nothing
        returning id, scope, idempotency_key, command_type, payload_hash,
                  actor_staff_user_id, actor_person_id, application_id, contract_id, response
      `);
      const row = result.rows[0];
      if (row !== undefined) return { ...mapCommand(row), inserted: true };
      const existing = await executor.execute<AssetContractCommandRow>(sql`
        select id, scope, idempotency_key, command_type, payload_hash,
               actor_staff_user_id, actor_person_id, application_id, contract_id, response
          from asset_contract_command
         where scope = ${input.scope} and idempotency_key = ${input.idempotencyKey}
         limit 1
      `);
      const existingRow = existing.rows[0];
      if (existingRow === undefined)
        throw new Error("ASSET_COMMAND_INSERT_FAILED");
      return { ...mapCommand(existingRow), inserted: false };
    },

    async updateCommandResponse(
      scope: string,
      idempotencyKey: string,
      response: Record<string, unknown>,
    ): Promise<void> {
      await executor.execute(sql`
        update asset_contract_command
           set response = ${JSON.stringify(response)}::jsonb
         where scope = ${scope} and idempotency_key = ${idempotencyKey}
      `);
    },

    async insertVehicle(input: {
      id: string;
      vehicleModelId: string;
      vin: string;
      chassisNumber: string;
      engineMotorIdentifier: string;
      condition: Record<string, unknown>;
      accessories: readonly string[];
      trackerIdentifier?: string;
      now: Date;
    }): Promise<VehicleRow> {
      const result = await executor.execute<VehicleRow>(sql`
        insert into vehicle_unit
          (id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
           condition, accessories, tracker_identifier, status, version, created_at, updated_at)
        values (${input.id}::uuid, ${input.vehicleModelId}::uuid, ${input.vin}, ${input.chassisNumber},
                ${input.engineMotorIdentifier}, ${JSON.stringify(input.condition)}::jsonb,
                ${JSON.stringify(input.accessories)}::jsonb, ${input.trackerIdentifier ?? null},
                'IN_STOCK', 1, ${input.now}, ${input.now})
        returning id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
                  condition, accessories, tracker_identifier, registration_number, status, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("VEHICLE_INSERT_FAILED");
      return row;
    },

    async listVehicles(): Promise<VehicleRow[]> {
      const result = await executor.execute<VehicleRow>(sql`
        select id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
               condition, accessories, tracker_identifier, registration_number, status, version
          from vehicle_unit order by created_at desc, id desc
      `);
      return result.rows;
    },

    async lockVehicle(id: string): Promise<VehicleRow | null> {
      const result = await executor.execute<VehicleRow>(sql`
        select id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
               condition, accessories, tracker_identifier, registration_number, status, version
          from vehicle_unit where id = ${id}::uuid for update
      `);
      return result.rows[0] ?? null;
    },

    async findApplication(
      id: string,
      lock = false,
    ): Promise<ApplicationRow | null> {
      const lockClause = lock ? sql` for update` : sql``;
      const result = await executor.execute<ApplicationRow>(sql`
        select app.id, app.applicant_person_id,
               (select relationship.guarantor_person_id
                  from guarantor_relationship relationship
                 where relationship.application_id = app.id
                   and relationship.status = 'CONFIRMED'
                 order by relationship.confirmed_at desc nulls last, relationship.id desc
                 limit 1) as guarantor_person_id,
               app.vehicle_model_id, app.status, app.version
          from application app
         where app.id = ${id}::uuid
         limit 1${lockClause}
      `);
      return result.rows[0] ?? null;
    },

    async validCustomerSessionBinding(input: {
      customerAccountId: string;
      customerSessionId: string;
      personId: string;
      now: Date;
    }): Promise<boolean> {
      const result = await executor.execute<{ ok: boolean }>(sql`
        select true as ok
          from customer_session session
          join customer_account account on account.id = session.customer_account_id
         where session.id = ${input.customerSessionId}::uuid
           and session.customer_account_id = ${input.customerAccountId}::uuid
           and account.person_id = ${input.personId}::uuid
           and account.status = 'ACTIVE'
           and session.revoked_at is null
           and session.expires_at > ${input.now}
         limit 1
      `);
      return result.rows[0]?.ok === true;
    },

    async lockOfferByApplication(
      applicationId: string,
    ): Promise<OfferRow | null> {
      const result = await executor.execute<OfferRow>(sql`
        select o.id, o.application_id, o.status, o.version, o.expires_at,
               o.accepted_version_id, o.accepted_hash,
               ov.id as offer_version_id, ov.version_number as offer_version_number,
               ov.financing_rule_version_id as offer_financing_rule_version_id,
               ov.principal_minor_units, ov.deposit_minor_units,
               ov.total_payable_minor_units, ov.terms, ov.canonical_hash
          from offer o
          join offer_version ov on ov.id = o.accepted_version_id
         where o.application_id = ${applicationId}::uuid
         order by ov.version_number desc
         limit 1 for update of o, ov
      `);
      return result.rows[0] ?? null;
    },

    async lockOfferById(id: string): Promise<OfferRow | null> {
      const result = await executor.execute<OfferRow>(sql`
        select o.id, o.application_id, o.status, o.version, o.expires_at,
               o.accepted_version_id, o.accepted_hash,
               ov.id as offer_version_id, ov.version_number as offer_version_number,
               ov.financing_rule_version_id as offer_financing_rule_version_id,
               ov.principal_minor_units, ov.deposit_minor_units,
               ov.total_payable_minor_units, ov.terms, ov.canonical_hash
          from offer o
          join offer_version ov on ov.id = o.accepted_version_id
         where o.id = ${id}::uuid
         limit 1 for update of o, ov
      `);
      return result.rows[0] ?? null;
    },

    async findDeposit(
      applicationId: string,
      offerId: string,
    ): Promise<DepositRow | null> {
      const result = await executor.execute<DepositRow>(sql`
        select id, application_id, offer_id, amount_minor_units, currency,
               status, reconciled_at, evidence_hash
          from deposit_reconciliation
         where application_id = ${applicationId}::uuid
           and offer_id = ${offerId}::uuid
           and status = 'RECONCILED'
         order by reconciled_at desc nulls last, id desc
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async bindPreContractDeposit(input: {
      contractId: string;
      applicationId: string;
      offerId: string;
      expectedAmountMinor: bigint;
      occurredAt: Date;
      allowUnlinkedReconciledDeposit?: boolean;
    }): Promise<{
      paymentTransactionId: string | null;
      ledgerEntryId: string;
    }> {
      const deposit = await executor.execute<{
        id: string;
        payment_transaction_id: string | null;
        amount_minor_units: bigint | string;
        evidence_hash: string;
      }>(sql`
        select id, payment_transaction_id, amount_minor_units, evidence_hash
          from deposit_reconciliation
         where application_id = ${input.applicationId}::uuid
           and offer_id = ${input.offerId}::uuid
           and status = 'RECONCILED'
         order by reconciled_at desc nulls last, id desc
         limit 1
         for update
      `);
      const row = deposit.rows[0];
      if (
        row === undefined ||
        BigInt(row.amount_minor_units) !== input.expectedAmountMinor ||
        (row.payment_transaction_id === null &&
          input.allowUnlinkedReconciledDeposit !== true)
      )
        throw new Error("DEPOSIT_RECONCILIATION_REQUIRED");
      let paymentId = row.payment_transaction_id;
      let policyVersion = "finance-policy-v1";
      if (paymentId !== null) {
        const provider = await executor.execute<{
          allocation_policy_version: string | null;
        }>(sql`
          select provider_payload->>'allocationPolicyVersion' as allocation_policy_version
            from payment_transaction
           where id = ${paymentId}::uuid
           for update
        `);
        policyVersion =
          provider.rows[0]?.allocation_policy_version ?? "finance-policy-v1";
        const payment = await executor.execute<{ id: string }>(sql`
          update payment_transaction
             set contract_id = ${input.contractId}::uuid,
                 status = 'POSTED',
                 version = version + 1,
                 updated_at = ${input.occurredAt}
           where id = ${paymentId}::uuid
             and contract_id is null
             and status = 'MATCHED'
           returning id
        `);
        paymentId = payment.rows[0]?.id ?? paymentId;
        const receipt = await executor.execute<{
          id: string;
          contract_id: string | null;
        }>(sql`
          select id, contract_id::text as contract_id
            from payment_receipt
           where payment_transaction_id = ${paymentId}::uuid
             and (contract_id is null or contract_id = ${input.contractId}::uuid)
           for update
        `);
        const receiptRow = receipt.rows[0];
        if (receiptRow === undefined)
          throw new Error("PAYMENT_RECEIPT_REQUIRED");
        if (receiptRow.contract_id === null)
          await executor.execute(sql`
            update payment_receipt
               set contract_id = ${input.contractId}::uuid
             where id = ${receiptRow.id}::uuid
          `);
      }
      const contract = await executor.execute<{
        outstanding_balance_minor_units: bigint | string;
      }>(sql`
        select outstanding_balance_minor_units
          from contract
         where id = ${input.contractId}::uuid
         for update
      `);
      const contractRow = contract.rows[0];
      if (contractRow === undefined) throw new Error("CONTRACT_NOT_FOUND");
      const ledger = await executor.execute<{ id: string }>(sql`
        insert into ledger_entry
          (id, posting_key, contract_id, payment_transaction_id, entry_type,
           direction, currency, amount_minor_units, balance_after_minor_units,
           allocation_policy_version, metadata, occurred_at)
        values (
          ${randomUUID()}::uuid,
          ${`PRE_CONTRACT_DEPOSIT:${paymentId ?? row.id}`},
          ${input.contractId}::uuid,
          ${paymentId === null ? sql`null` : sql`${paymentId}::uuid`},
          'DEPOSIT',
          'CREDIT',
          'GHS',
          ${input.expectedAmountMinor}::bigint,
          ${contractRow.outstanding_balance_minor_units}::bigint,
          ${policyVersion},
          ${JSON.stringify({
            source: "PRE_CONTRACT_DEPOSIT",
            depositReconciliationId: row.id,
            evidenceHash: row.evidence_hash,
          })}::jsonb,
          ${input.occurredAt}
        )
        on conflict (posting_key) do update
           set posting_key = excluded.posting_key
        returning id
      `);
      const ledgerRow = ledger.rows[0];
      if (ledgerRow === undefined)
        throw new Error("DEPOSIT_LEDGER_POST_FAILED");
      return { paymentTransactionId: paymentId, ledgerEntryId: ledgerRow.id };
    },

    async currentAssignment(
      applicationId: string,
      lock = false,
    ): Promise<AssignmentRow | null> {
      const lockClause = lock ? sql` for update` : sql``;
      const result = await executor.execute<AssignmentRow>(sql`
        select id, application_id, vehicle_unit_id, offer_id, offer_version_id,
               deposit_reconciled_amount_minor_units, deposit_evidence_id,
               supersedes_assignment_id, reassignment_approved_by, reassignment_reason,
               assigned_by, assigned_at, released_at, version
          from vehicle_assignment
         where application_id = ${applicationId}::uuid and released_at is null
         limit 1${lockClause}
      `);
      return result.rows[0] ?? null;
    },

    async findAssignment(id: string): Promise<AssignmentRow | null> {
      const result = await executor.execute<AssignmentRow>(sql`
        select id, application_id, vehicle_unit_id, offer_id, offer_version_id,
               deposit_reconciled_amount_minor_units, deposit_evidence_id,
               supersedes_assignment_id, reassignment_approved_by, reassignment_reason,
               assigned_by, assigned_at, released_at, version
          from vehicle_assignment where id = ${id}::uuid limit 1
      `);
      return result.rows[0] ?? null;
    },

    async insertReassignmentApproval(input: {
      id: string;
      applicationId: string;
      previousAssignmentId: string;
      requestedVehicleUnitId: string;
      requestedBy: string;
      requestedByRole: string;
      reason: string;
      effectiveFrom: Date;
      effectiveUntil?: Date;
      contractId?: string;
      status?: "PENDING" | "APPROVED";
      approvedBy?: string;
      approvedByRole?: string;
      approvedAt?: Date;
    }): Promise<ReassignmentApprovalRow> {
      const result = await executor.execute<ReassignmentApprovalRow>(sql`
        insert into vehicle_reassignment_approval
          (id, application_id, previous_assignment_id, requested_vehicle_unit_id,
           contract_id, requested_by, requested_by_role, approved_by,
           approved_by_role, status, reason, effective_from, effective_until,
           approved_at)
        values (${input.id}::uuid, ${input.applicationId}::uuid,
                ${input.previousAssignmentId}::uuid, ${input.requestedVehicleUnitId}::uuid,
                ${input.contractId ?? null}::uuid, ${input.requestedBy}::uuid,
                ${input.requestedByRole}, ${input.approvedBy ?? null}::uuid,
                ${input.approvedByRole ?? null}, ${input.status ?? "PENDING"},
                ${input.reason}, ${input.effectiveFrom},
                ${input.effectiveUntil ?? null}, ${input.approvedAt ?? null})
        returning id, application_id, previous_assignment_id, requested_vehicle_unit_id,
                  contract_id, requested_by, requested_by_role, approved_by,
                  approved_by_role, status, reason, effective_from, effective_until,
                  approved_at, created_at
      `);
      const row = result.rows[0];
      if (row === undefined)
        throw new Error("REASSIGNMENT_APPROVAL_INSERT_FAILED");
      return row;
    },

    async findReassignmentApproval(
      id: string,
      lock = false,
    ): Promise<ReassignmentApprovalRow | null> {
      const lockClause = lock ? sql` for update` : sql``;
      const result = await executor.execute<ReassignmentApprovalRow>(sql`
        select id, application_id, previous_assignment_id, requested_vehicle_unit_id,
               contract_id, requested_by, requested_by_role, approved_by,
               approved_by_role, status, reason, effective_from, effective_until,
               approved_at, created_at
          from vehicle_reassignment_approval
         where id = ${id}::uuid
         limit 1${lockClause}
      `);
      return result.rows[0] ?? null;
    },

    async approveReassignmentApproval(input: {
      id: string;
      approvedBy: string;
      approvedByRole: string;
      approvedAt: Date;
      now: Date;
    }): Promise<ReassignmentApprovalRow | null> {
      const result = await executor.execute<ReassignmentApprovalRow>(sql`
        update vehicle_reassignment_approval
           set status = 'APPROVED', approved_by = ${input.approvedBy}::uuid,
               approved_by_role = ${input.approvedByRole}, approved_at = ${input.approvedAt}
         where id = ${input.id}::uuid
           and status = 'PENDING'
           and effective_from <= ${input.now}
           and (effective_until is null or effective_until > ${input.now})
        returning id, application_id, previous_assignment_id, requested_vehicle_unit_id,
                  contract_id, requested_by, requested_by_role, approved_by,
                  approved_by_role, status, reason, effective_from, effective_until,
                  approved_at, created_at
      `);
      return result.rows[0] ?? null;
    },

    async findEffectiveReassignmentApproval(input: {
      id: string;
      applicationId: string;
      previousAssignmentId: string;
      requestedVehicleUnitId: string;
      now: Date;
    }): Promise<ReassignmentApprovalRow | null> {
      const result = await executor.execute<ReassignmentApprovalRow>(sql`
        select id, application_id, previous_assignment_id, requested_vehicle_unit_id,
               contract_id, requested_by, requested_by_role, approved_by,
               approved_by_role, status, reason, effective_from, effective_until,
               approved_at, created_at
          from vehicle_reassignment_approval
         where id = ${input.id}::uuid
           and application_id = ${input.applicationId}::uuid
           and previous_assignment_id = ${input.previousAssignmentId}::uuid
           and requested_vehicle_unit_id = ${input.requestedVehicleUnitId}::uuid
           and status = 'APPROVED'
           and effective_from <= ${input.now}
           and (effective_until is null or effective_until > ${input.now})
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async insertAssignment(input: {
      id: string;
      applicationId: string;
      vehicleUnitId: string;
      offerId: string;
      offerVersionId: string;
      depositAmountMinor: bigint;
      depositEvidenceId: string;
      supersedesAssignmentId?: string;
      reassignmentApprovedBy?: string;
      reassignmentReason?: string;
      assignedBy: string;
      assignedAt: Date;
    }): Promise<AssignmentRow> {
      const result = await executor.execute<AssignmentRow>(sql`
        insert into vehicle_assignment
          (id, application_id, vehicle_unit_id, offer_id, offer_version_id,
           deposit_reconciled_amount_minor_units, deposit_evidence_id,
           supersedes_assignment_id, reassignment_approved_by, reassignment_reason,
           assigned_by, assigned_at, version)
        values (${input.id}::uuid, ${input.applicationId}::uuid, ${input.vehicleUnitId}::uuid,
                ${input.offerId}::uuid, ${input.offerVersionId}::uuid,
                ${input.depositAmountMinor}::bigint, ${input.depositEvidenceId}::uuid,
                ${input.supersedesAssignmentId ?? null}::uuid,
                ${input.reassignmentApprovedBy ?? null}::uuid,
                ${input.reassignmentReason ?? null}, ${input.assignedBy}::uuid,
                ${input.assignedAt}, 1)
        returning id, application_id, vehicle_unit_id, offer_id, offer_version_id,
                  deposit_reconciled_amount_minor_units, deposit_evidence_id,
                  supersedes_assignment_id, reassignment_approved_by, reassignment_reason,
                  assigned_by, assigned_at, released_at, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("ASSIGNMENT_INSERT_FAILED");
      return row;
    },

    async releaseAssignment(
      id: string,
      expectedVersion: number,
      releasedAt: Date,
    ): Promise<void> {
      const result = await executor.execute(sql`
        update vehicle_assignment
           set released_at = ${releasedAt}, version = version + 1
         where id = ${id}::uuid and version = ${expectedVersion} and released_at is null
      `);
      if (result.rowCount !== 1) throw new Error("ASSIGNMENT_VERSION_CONFLICT");
    },

    async updateVehicleStatus(
      id: string,
      expectedVersion: number,
      status: string,
      now: Date,
    ): Promise<VehicleRow> {
      const result = await executor.execute<VehicleRow>(sql`
        update vehicle_unit
           set status = ${status}, version = version + 1, updated_at = ${now}
         where id = ${id}::uuid and version = ${expectedVersion}
        returning id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
                  condition, accessories, tracker_identifier, registration_number, status, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("VEHICLE_VERSION_CONFLICT");
      return row;
    },

    async updateVehicleRegistrationSummary(
      id: string,
      expectedVersion: number,
      registrationNumber: string,
      now: Date,
    ): Promise<VehicleRow> {
      const result = await executor.execute<VehicleRow>(sql`
        update vehicle_unit
           set registration_number = ${registrationNumber}, version = version + 1,
               updated_at = ${now}
         where id = ${id}::uuid and version = ${expectedVersion}
        returning id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
                  condition, accessories, tracker_identifier, registration_number, status, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("VEHICLE_VERSION_CONFLICT");
      return row;
    },

    async bumpVehicleVersion(
      id: string,
      expectedVersion: number,
      now: Date,
    ): Promise<VehicleRow> {
      const result = await executor.execute<VehicleRow>(sql`
        update vehicle_unit
           set version = version + 1, updated_at = ${now}
         where id = ${id}::uuid and version = ${expectedVersion}
        returning id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
                  condition, accessories, tracker_identifier, registration_number, status, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("VEHICLE_VERSION_CONFLICT");
      return row;
    },

    async updateVehicleTrackerIdentifier(
      id: string,
      expectedVersion: number,
      trackerIdentifier: string,
      now: Date,
    ): Promise<VehicleRow> {
      const result = await executor.execute<VehicleRow>(sql`
        update vehicle_unit
           set tracker_identifier = ${trackerIdentifier}, version = version + 1,
               updated_at = ${now}
         where id = ${id}::uuid and version = ${expectedVersion}
        returning id, vehicle_model_id, vin, chassis_number, engine_motor_identifier,
                  condition, accessories, tracker_identifier, registration_number, status, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("VEHICLE_VERSION_CONFLICT");
      return row;
    },

    async findCurrentInsuranceRegistration(vehicleUnitId: string): Promise<{
      registration_valid_from: string | null;
      registration_valid_to: string | null;
      insurance_valid_from: string | null;
      insurance_valid_to: string | null;
      registration_number: string | null;
      insurance_policy_number: string | null;
    } | null> {
      const result = await executor.execute<{
        registration_valid_from: string | null;
        registration_valid_to: string | null;
        insurance_valid_from: string | null;
        insurance_valid_to: string | null;
        registration_number: string | null;
        insurance_policy_number: string | null;
      }>(sql`
        select registration.valid_from as registration_valid_from,
               registration.valid_to as registration_valid_to,
               insurance.valid_from as insurance_valid_from,
               insurance.valid_to as insurance_valid_to,
               registration.registration_number,
               insurance.policy_number as insurance_policy_number
          from (select * from registration_record where vehicle_unit_id = ${vehicleUnitId}::uuid order by valid_to desc nulls last, created_at desc limit 1) registration
          full join (select * from insurance_record where vehicle_unit_id = ${vehicleUnitId}::uuid order by valid_to desc, created_at desc limit 1) insurance on true
      `);
      return result.rows[0] ?? null;
    },

    async insertRegistration(input: {
      id: string;
      vehicleUnitId: string;
      registrationNumber: string;
      validFrom: string;
      validTo: string;
      evidenceDocumentId?: string;
      now: Date;
    }): Promise<void> {
      await executor.execute(sql`
        insert into registration_record
          (id, vehicle_unit_id, registration_number, registered_owner, valid_from, valid_to, evidence_document_id, created_at)
        values (${input.id}::uuid, ${input.vehicleUnitId}::uuid, ${input.registrationNumber},
                'SOMOCO', ${input.validFrom}::date, ${input.validTo}::date,
                ${input.evidenceDocumentId ?? null}::uuid, ${input.now})
      `);
    },

    async insertInsurance(input: {
      id: string;
      vehicleUnitId: string;
      policyNumber: string;
      provider: string;
      validFrom: string;
      validTo: string;
      evidenceDocumentId?: string;
      now: Date;
    }): Promise<void> {
      await executor.execute(sql`
        insert into insurance_record
          (id, vehicle_unit_id, policy_number, provider, valid_from, valid_to, evidence_document_id, created_at)
        values (${input.id}::uuid, ${input.vehicleUnitId}::uuid, ${input.policyNumber}, ${input.provider},
                ${input.validFrom}::date, ${input.validTo}::date,
                ${input.evidenceDocumentId ?? null}::uuid, ${input.now})
      `);
    },

    async insertTracker(input: {
      id: string;
      vehicleUnitId: string;
      trackerId: string;
      associatedAt: Date;
    }): Promise<void> {
      await executor.execute(sql`
        insert into tracker_association
          (id, vehicle_unit_id, provider, provider_device_id, deep_link, associated_at)
        values (${input.id}::uuid, ${input.vehicleUnitId}::uuid, 'ATTESTED_TRACKER_PORT',
                ${input.trackerId}, null, ${input.associatedAt})
      `);
    },

    async currentTracker(vehicleUnitId: string): Promise<{
      association_id: string;
      tracker_identifier: string | null;
      provider: string;
      provider_device_id: string;
      deep_link: string | null;
    } | null> {
      const result = await executor.execute<{
        association_id: string;
        tracker_identifier: string | null;
        provider: string;
        provider_device_id: string;
        deep_link: string | null;
      }>(sql`
        select tracker.id as association_id, vehicle.tracker_identifier,
               tracker.provider, tracker.provider_device_id, tracker.deep_link
          from tracker_association tracker
          join vehicle_unit vehicle on vehicle.id = tracker.vehicle_unit_id
         where tracker.vehicle_unit_id = ${vehicleUnitId}::uuid and tracker.ended_at is null
         order by tracker.associated_at desc, tracker.id desc limit 1
      `);
      return result.rows[0] ?? null;
    },

    async updateApplicationStatus(input: {
      id: string;
      expectedVersion: number;
      status: string;
      now: Date;
    }): Promise<void> {
      const result = await executor.execute(sql`
        update application
           set status = ${input.status}, version = version + 1, updated_at = ${input.now}
         where id = ${input.id}::uuid and version = ${input.expectedVersion}
      `);
      if (result.rowCount !== 1)
        throw new Error("APPLICATION_VERSION_CONFLICT");
    },

    async insertRepaymentSchedule(input: {
      contractId: string;
      totalMinor: bigint;
      firstDueDate: string;
      installments: readonly {
        sequence: number;
        dueDate: string;
        totalMinor: bigint;
      }[];
    }): Promise<void> {
      const scheduleId = randomUUID();
      await executor.execute(sql`
        insert into repayment_schedule
          (id, contract_id, version_number, total_minor_units, first_due_date)
        values (${scheduleId}::uuid, ${input.contractId}::uuid, 1,
                ${input.totalMinor}::bigint, ${input.firstDueDate}::date)
        on conflict (contract_id, version_number) do nothing
      `);
      for (const installment of input.installments) {
        await executor.execute(sql`
          insert into installment
            (id, contract_id, repayment_schedule_id, installment_number,
             due_date, amount_minor_units, paid_minor_units, status, version)
          values (${randomUUID()}::uuid, ${input.contractId}::uuid, ${scheduleId}::uuid,
                  ${installment.sequence}, ${installment.dueDate}::date,
                  ${installment.totalMinor}::bigint, 0, 'PENDING', 1)
          on conflict (repayment_schedule_id, installment_number) do nothing
        `);
      }
    },

    async customerVehicleSummary(
      applicationId: string,
      vehicleUnitId?: string,
    ): Promise<{
      vehicle_model_id: string;
      registration_number: string | null;
      registration_valid_to: string | null;
      insurance_valid_to: string | null;
      handed_over: boolean;
    } | null> {
      const result = await executor.execute<{
        vehicle_model_id: string;
        registration_number: string | null;
        registration_valid_to: string | null;
        insurance_valid_to: string | null;
        handed_over: boolean;
      }>(sql`
        select vehicle.vehicle_model_id,
               registration.registration_number,
               registration.valid_to as registration_valid_to,
               insurance.valid_to as insurance_valid_to,
               vehicle.status = 'HANDED_OVER' as handed_over
          from vehicle_assignment assignment
          join vehicle_unit vehicle on vehicle.id = assignment.vehicle_unit_id
          left join lateral (
            select registration_number, valid_to from registration_record
             where vehicle_unit_id = vehicle.id order by valid_to desc nulls last, created_at desc limit 1
          ) registration on true
          left join lateral (
            select valid_to from insurance_record
             where vehicle_unit_id = vehicle.id order by valid_to desc, created_at desc limit 1
          ) insurance on true
         where assignment.application_id = ${applicationId}::uuid
           and assignment.released_at is null
           and (${vehicleUnitId ?? null}::uuid is null or assignment.vehicle_unit_id = ${vehicleUnitId ?? null}::uuid)
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async insertTemplate(input: {
      id: string;
      templateKey: string;
      versionNumber: number;
      contentHash: string;
      approvedPdfHash: string;
      approvedBy: string;
      approvedAt: Date;
      effectiveFrom: Date;
      effectiveUntil?: Date;
      attestationMode: "PRODUCTION" | "TEST";
    }): Promise<TemplateRow> {
      const result = await executor.execute<TemplateRow>(sql`
        insert into contract_template_version
          (id, template_key, version_number, content_hash, approved_pdf_hash,
           approved_by, approved_at, effective_from, effective_until, published_at, attestation_mode)
        values (${input.id}::uuid, ${input.templateKey}, ${input.versionNumber}, ${input.contentHash},
                ${input.approvedPdfHash}, ${input.approvedBy}::uuid, ${input.approvedAt},
                ${input.effectiveFrom}, ${input.effectiveUntil ?? null}, ${input.approvedAt}, ${input.attestationMode})
        returning id, template_key, version_number, content_hash, approved_pdf_hash,
                  approved_by, approved_at, effective_from, effective_until, published_at, attestation_mode
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("CONTRACT_TEMPLATE_INSERT_FAILED");
      return row;
    },

    async findTemplate(id: string, now: Date): Promise<TemplateRow | null> {
      const result = await executor.execute<TemplateRow>(sql`
        select id, template_key, version_number, content_hash, approved_pdf_hash,
               approved_by, approved_at, effective_from, effective_until, published_at, attestation_mode
          from contract_template_version
         where id = ${id}::uuid
           and effective_from <= ${now}
           and (effective_until is null or effective_until > ${now})
           and published_at <= ${now}
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async insertContract(input: {
      id: string;
      reference: string;
      applicationId: string;
      offerVersionId: string;
      templateVersionId: string;
      vehicleUnitId: string;
      canonicalHash: string;
      previewReference: string;
      outstandingBalanceMinor: bigint;
      generatedAt: Date;
    }): Promise<ContractRow> {
      const result = await executor.execute<ContractRow>(sql`
        insert into contract
          (id, reference, application_id, offer_version_id, template_version_id,
           vehicle_unit_id, status, canonical_hash, preview_reference, ownership_holder,
           outstanding_balance_minor_units, version, generated_at, created_at, updated_at)
        values (${input.id}::uuid, ${input.reference}, ${input.applicationId}::uuid,
                ${input.offerVersionId}::uuid, ${input.templateVersionId}::uuid,
                ${input.vehicleUnitId}::uuid, 'AWAITING_EXECUTION', ${input.canonicalHash},
                ${input.previewReference}, 'SOMOCO', ${input.outstandingBalanceMinor}::bigint,
                1, ${input.generatedAt}, ${input.generatedAt}, ${input.generatedAt})
        returning id, reference, application_id, offer_version_id, template_version_id,
                  vehicle_unit_id, status, canonical_hash, preview_reference, ownership_holder,
                  outstanding_balance_minor_units, version, activated_at, generated_at
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("CONTRACT_INSERT_FAILED");
      return row;
    },

    async lockContract(id: string): Promise<ContractRow | null> {
      const result = await executor.execute<ContractRow>(sql`
        select id, reference, application_id, offer_version_id, template_version_id,
               vehicle_unit_id, status, canonical_hash, preview_reference, ownership_holder,
               outstanding_balance_minor_units, version, activated_at, generated_at
          from contract where id = ${id}::uuid for update
      `);
      return result.rows[0] ?? null;
    },

    async findContractByApplication(
      applicationId: string,
    ): Promise<ContractRow | null> {
      const result = await executor.execute<ContractRow>(sql`
        select id, reference, application_id, offer_version_id, template_version_id,
               vehicle_unit_id, status, canonical_hash, preview_reference, ownership_holder,
               outstanding_balance_minor_units, version, activated_at, generated_at
          from contract where application_id = ${applicationId}::uuid limit 1
      `);
      return result.rows[0] ?? null;
    },

    async updateContractStatus(input: {
      id: string;
      expectedVersion: number;
      status: string;
      now: Date;
      activatedAt?: Date;
    }): Promise<ContractRow> {
      const result = await executor.execute<ContractRow>(sql`
        update contract
           set status = ${input.status}, version = version + 1,
               activated_at = coalesce(${input.activatedAt ?? null}, activated_at), updated_at = ${input.now}
         where id = ${input.id}::uuid and version = ${input.expectedVersion}
        returning id, reference, application_id, offer_version_id, template_version_id,
                  vehicle_unit_id, status, canonical_hash, preview_reference, ownership_holder,
                  outstanding_balance_minor_units, version, activated_at, generated_at
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("CONTRACT_VERSION_CONFLICT");
      return row;
    },

    async insertExecution(input: {
      id: string;
      contractId: string;
      versionNumber: number;
      applicantPersonId: string;
      guarantorPersonId: string;
      staffWitnessId: string;
      executionDate: Date;
      headOfficeId: string;
      headOfficeLocation: string;
      executedDocumentId: string;
      executedDocumentHash: string;
      authorizationReason?: string;
    }): Promise<ExecutionRow> {
      const result = await executor.execute<ExecutionRow>(sql`
        insert into contract_execution
          (id, contract_id, version_number, applicant_person_id, guarantor_person_id,
           staff_witness_id, execution_date,
           head_office_id, head_office_location, executed_document_id,
           executed_document_hash, authorization_reason)
        values (${input.id}::uuid, ${input.contractId}::uuid, ${input.versionNumber},
                ${input.applicantPersonId}::uuid, ${input.guarantorPersonId}::uuid,
                ${input.staffWitnessId}::uuid,
                ${input.executionDate}, ${input.headOfficeId}, ${input.headOfficeLocation}, ${input.executedDocumentId}::uuid,
                ${input.executedDocumentHash}, ${input.authorizationReason ?? null})
        returning id, contract_id, version_number, applicant_person_id, guarantor_person_id,
                  staff_witness_id, execution_date,
                  head_office_id, head_office_location, executed_document_id,
                  executed_document_hash, authorization_reason
      `);
      const row = result.rows[0];
      if (row === undefined)
        throw new Error("CONTRACT_EXECUTION_INSERT_FAILED");
      return row;
    },

    async latestExecution(contractId: string): Promise<ExecutionRow | null> {
      const result = await executor.execute<ExecutionRow>(sql`
        select id, contract_id, version_number, applicant_person_id, guarantor_person_id,
               staff_witness_id, execution_date,
               head_office_id, head_office_location, executed_document_id,
               executed_document_hash, authorization_reason
          from contract_execution where contract_id = ${contractId}::uuid
         order by version_number desc limit 1
      `);
      return result.rows[0] ?? null;
    },

    async insertHandover(input: {
      id: string;
      contractId: string;
      checklist: Record<string, unknown>;
      checklistVersion: string;
      customerAcknowledgedAt: Date;
      customerAcknowledgedByPersonId: string;
      headOfficeId: string;
      condition: unknown;
      accessories: unknown;
      headOfficeLocation: string;
      handedOverBy: string;
      handedOverAt: Date;
    }): Promise<HandoverRow> {
      const result = await executor.execute<HandoverRow>(sql`
        insert into handover_record
          (id, contract_id, checklist, checklist_version, customer_acknowledged_at,
           customer_acknowledged_by_person_id, head_office_id, condition, accessories, head_office_location,
           handed_over_by, handed_over_at, version)
        values (${input.id}::uuid, ${input.contractId}::uuid, ${JSON.stringify(input.checklist)}::jsonb,
                ${input.checklistVersion}, ${input.customerAcknowledgedAt},
                ${input.customerAcknowledgedByPersonId}::uuid, ${input.headOfficeId}, ${JSON.stringify(input.condition)}::jsonb,
                ${JSON.stringify(input.accessories)}::jsonb, ${input.headOfficeLocation},
                ${input.handedOverBy}::uuid, ${input.handedOverAt}, 1)
        returning id, contract_id, checklist, checklist_version, customer_acknowledged_at,
                  customer_acknowledged_by_person_id, head_office_id, condition, accessories, head_office_location,
                  handed_over_by, handed_over_at, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("HANDOVER_INSERT_FAILED");
      return row;
    },

    async findHandover(contractId: string): Promise<HandoverRow | null> {
      const result = await executor.execute<HandoverRow>(sql`
        select id, contract_id, checklist, checklist_version, customer_acknowledged_at,
               customer_acknowledged_by_person_id, head_office_id, condition, accessories, head_office_location,
               handed_over_by, handed_over_at, version
          from handover_record where contract_id = ${contractId}::uuid limit 1
      `);
      return result.rows[0] ?? null;
    },

    async insertHandoverAcknowledgement(input: {
      id: string;
      contractId: string;
      applicationId: string;
      personId: string;
      customerAccountId: string;
      customerSessionId: string;
      checklistVersion: string;
      checklistHash: string;
      acknowledgedAt: Date;
      idempotencyKey: string;
    }): Promise<HandoverAcknowledgementRow> {
      const result = await executor.execute<HandoverAcknowledgementRow>(sql`
        insert into handover_customer_acknowledgement
          (id, contract_id, application_id, person_id, customer_account_id,
           customer_session_id, checklist_version, checklist_hash,
           acknowledged_at, idempotency_key)
        values (${input.id}::uuid, ${input.contractId}::uuid,
                ${input.applicationId}::uuid, ${input.personId}::uuid,
                ${input.customerAccountId}::uuid, ${input.customerSessionId}::uuid,
                ${input.checklistVersion}, ${input.checklistHash},
                ${input.acknowledgedAt}, ${input.idempotencyKey})
        returning id, contract_id, application_id, person_id, customer_account_id,
                  customer_session_id, checklist_version, checklist_hash,
                  acknowledged_at, idempotency_key
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("HANDOVER_ACK_INSERT_FAILED");
      return row;
    },

    async findHandoverAcknowledgement(
      id: string,
      lock = false,
    ): Promise<HandoverAcknowledgementRow | null> {
      const lockClause = lock ? sql` for update` : sql``;
      const result = await executor.execute<HandoverAcknowledgementRow>(sql`
        select id, contract_id, application_id, person_id, customer_account_id,
               customer_session_id, checklist_version, checklist_hash,
               acknowledged_at, idempotency_key
          from handover_customer_acknowledgement
         where id = ${id}::uuid
         limit 1${lockClause}
      `);
      return result.rows[0] ?? null;
    },

    async findLatestHandoverAcknowledgement(
      contractId: string,
    ): Promise<HandoverAcknowledgementRow | null> {
      const result = await executor.execute<HandoverAcknowledgementRow>(sql`
        select id, contract_id, application_id, person_id, customer_account_id,
               customer_session_id, checklist_version, checklist_hash,
               acknowledged_at, idempotency_key
          from handover_customer_acknowledgement
         where contract_id = ${contractId}::uuid
         order by acknowledged_at desc, id desc
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async cleanDocument(
      documentId: string,
      expectedHash: string,
    ): Promise<{ person_id: string; sha256: string } | null> {
      const result = await executor.execute<{
        person_id: string;
        sha256: string;
        document_type: string;
        declared_mime_type: string;
        accepted_object_key: string;
        accepted_object_version_id: string;
        accepted_object_etag: string;
        version: number;
      }>(sql`
        select person_id, sha256, document_type, declared_mime_type,
               accepted_object_key, accepted_object_version_id,
               accepted_object_etag, version
          from privacy.document
         where id = ${documentId}::uuid
           and status = 'ACCEPTED'
           and malware_scanned = true
           and sha256 = ${expectedHash}
           and document_type = 'EXECUTED_CONTRACT'
           and declared_mime_type = 'application/pdf'
           and length(btrim(coalesce(accepted_object_key, ''))) > 0
           and length(btrim(coalesce(accepted_object_version_id, ''))) > 0
           and length(btrim(coalesce(accepted_object_etag, ''))) > 0
           and version > 0
         limit 1
      `);
      return result.rows[0] ?? null;
    },

    async confirmedGuarantor(applicationId: string): Promise<string | null> {
      const result = await executor.execute<{
        guarantor_person_id: string;
      }>(sql`
        select guarantor_person_id from guarantor_relationship
         where application_id = ${applicationId}::uuid and status = 'CONFIRMED'
         order by confirmed_at desc nulls last, id desc limit 1
      `);
      return result.rows[0]?.guarantor_person_id ?? null;
    },

    async insertTrackerAccess(input: {
      id: string;
      vehicleUnitId: string;
      staffUserId: string;
      purpose: string;
      accessedAt: Date;
      context: Record<string, unknown>;
    }): Promise<{
      tracker_identifier: string | null;
      deep_link: string | null;
    }> {
      const result = await executor.execute<{
        tracker_identifier: string | null;
        deep_link: string | null;
      }>(sql`
        insert into tracker_access_log
          (id, tracker_association_id, actor_staff_user_id, purpose, accessed_at, context)
        select ${input.id}::uuid, tracker.id, ${input.staffUserId}::uuid, ${input.purpose},
               ${input.accessedAt}, ${JSON.stringify(input.context)}::jsonb
          from tracker_association tracker
         where tracker.vehicle_unit_id = ${input.vehicleUnitId}::uuid
           and tracker.ended_at is null
         order by tracker.associated_at desc, tracker.id desc
         limit 1
        returning (
          select vehicle.tracker_identifier from vehicle_unit vehicle
           where vehicle.id = ${input.vehicleUnitId}::uuid
        ) as tracker_identifier,
        (select tracker.deep_link from tracker_association tracker
           where tracker.vehicle_unit_id = ${input.vehicleUnitId}::uuid and tracker.ended_at is null
           order by tracker.associated_at desc, tracker.id desc limit 1) as deep_link
      `);
      return result.rows[0] ?? { tracker_identifier: null, deep_link: null };
    },
  };
}

interface AssetContractCommandRow extends Record<string, unknown> {
  id: string;
  scope: string;
  idempotency_key: string;
  command_type: string;
  payload_hash: string;
  actor_staff_user_id: string | null;
  actor_person_id: string | null;
  application_id: string | null;
  contract_id: string | null;
  response: Record<string, unknown>;
}

function mapCommand(row: AssetContractCommandRow): AssetContractCommandRecord {
  return {
    id: row.id,
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    commandType: row.command_type,
    payloadHash: row.payload_hash,
    actorStaffUserId: row.actor_staff_user_id,
    actorPersonId: row.actor_person_id,
    applicationId: row.application_id,
    contractId: row.contract_id,
    response: row.response,
  };
}
