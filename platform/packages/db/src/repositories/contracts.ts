import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { ownershipTransfer } from "../schema/contracts.js";
import { getInternalTransaction, withTransaction } from "../transaction.js";
import { persistWriteEffects, type WriteEffects } from "./effects.js";

export interface CompleteOwnershipTransferCommand {
  id: string;
  expectedVersion: number;
  evidence: Record<string, unknown>;
  approvedBy?: string;
  transferredAt: Date;
  effects: WriteEffects;
}

export async function completeOwnershipTransfer(
  db: Database,
  command: CompleteOwnershipTransferCommand,
) {
  return withTransaction(db, async (tx) => {
    const executor = getInternalTransaction(tx);
    const locked = await executor.execute<{
      version: number;
      contract_status: string;
      outstanding_balance_minor_units: string;
      ownership_holder: string;
      vehicle_unit_id: string;
      registration_number: string | null;
      registered_owner: string | null;
      valid_from: string | null;
      valid_to: string | null;
    }>(sql`
      select transfer.version,
             agreement.status as contract_status,
             agreement.outstanding_balance_minor_units,
             agreement.ownership_holder,
             agreement.vehicle_unit_id,
             registration.registration_number,
             registration.registered_owner::text,
             registration.valid_from::text,
             registration.valid_to::text
      from ownership_transfer as transfer
      join contract as agreement on agreement.id = transfer.contract_id
      left join lateral (
        select record.registration_number, record.registered_owner,
               record.valid_from, record.valid_to
          from registration_record record
         where record.vehicle_unit_id = agreement.vehicle_unit_id
         order by record.created_at desc, record.id desc limit 1
      ) registration on true
      where transfer.id = ${command.id}
      for update of transfer, agreement
    `);
    const record = locked.rows[0];
    if (record === undefined) {
      throw new Error("OWNERSHIP_TRANSFER_NOT_FOUND");
    }
    if (record.version !== command.expectedVersion) {
      throw new Error("OPTIMISTIC_LOCK_FAILED");
    }
    if (
      record.contract_status !== "SETTLED" ||
      record.ownership_holder !== "SOMOCO" ||
      BigInt(record.outstanding_balance_minor_units) !== 0n
    ) {
      throw new Error("CONTRACT_NOT_SETTLED");
    }
    const registrationEvidenceDocumentId =
      command.evidence.registrationEvidenceDocumentId;
    if (
      typeof registrationEvidenceDocumentId !== "string" ||
      record.registration_number === null ||
      record.registered_owner !== "SOMOCO" ||
      record.valid_from === null
    )
      throw new Error("REGISTRATION_TRANSFER_EVIDENCE_REQUIRED");

    await executor.execute(sql`
      update contract
         set status = 'TRANSFERRED', ownership_holder = 'CUSTOMER',
             version = version + 1, updated_at = ${command.transferredAt}
       where id = (select contract_id from ownership_transfer where id = ${command.id})
         and status = 'SETTLED' and ownership_holder = 'SOMOCO'
         and outstanding_balance_minor_units = 0
    `);
    await executor.execute(sql`
      update vehicle_unit
         set status = 'TRANSFERRED', version = version + 1,
             updated_at = ${command.transferredAt}
       where id = ${record.vehicle_unit_id}
    `);
    await executor.execute(sql`
      insert into registration_record
        (vehicle_unit_id, registration_number, registered_owner,
         valid_from, valid_to, evidence_document_id, created_at)
      values (${record.vehicle_unit_id}, ${record.registration_number}, 'CUSTOMER',
              ${record.valid_from}::date, ${record.valid_to}::date,
              ${registrationEvidenceDocumentId}::uuid,
              ${command.transferredAt})
    `);

    const [updated] = await executor
      .update(ownershipTransfer)
      .set({
        status: "COMPLETED",
        evidence: command.evidence,
        approvedBy: command.approvedBy,
        transferredAt: command.transferredAt,
        updatedAt: command.transferredAt,
        version: command.expectedVersion + 1,
      })
      .where(
        and(
          eq(ownershipTransfer.id, command.id),
          eq(ownershipTransfer.version, command.expectedVersion),
        ),
      )
      .returning();
    if (updated === undefined) {
      throw new Error("OPTIMISTIC_LOCK_FAILED");
    }

    await persistWriteEffects(tx, command.effects);
    return updated;
  });
}
