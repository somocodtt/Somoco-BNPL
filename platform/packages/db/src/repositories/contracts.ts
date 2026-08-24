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
      transfer_status: string;
      transfer_evidence: Record<string, unknown> | null;
      transfer_id: string;
      contract_status: string;
      outstanding_balance_minor_units: string;
      ownership_holder: string;
      vehicle_unit_id: string;
      vehicle_status: string;
      registration_number: string | null;
      registered_owner: string | null;
      valid_from: string | null;
      valid_to: string | null;
      registration_evidence_document_id: string | null;
    }>(sql`
      select transfer.id as transfer_id,
             transfer.version,
             transfer.status as transfer_status,
             transfer.evidence as transfer_evidence,
             agreement.status as contract_status,
             agreement.outstanding_balance_minor_units,
             agreement.ownership_holder,
             agreement.vehicle_unit_id,
             asset.status::text as vehicle_status,
             registration.registration_number,
             registration.registered_owner::text,
             registration.valid_from::text,
             registration.valid_to::text,
             registration.evidence_document_id::text
               as registration_evidence_document_id
      from ownership_transfer as transfer
      join contract as agreement on agreement.id = transfer.contract_id
      join vehicle_unit as asset on asset.id = agreement.vehicle_unit_id
      left join lateral (
        select record.registration_number, record.registered_owner,
               record.valid_from, record.valid_to,
               record.evidence_document_id
          from registration_record record
         where record.vehicle_unit_id = agreement.vehicle_unit_id
         order by record.created_at desc, record.id desc limit 1
      ) registration on true
      where transfer.id = ${command.id}
      for update of transfer, agreement, asset
    `);
    const record = locked.rows[0];
    if (record === undefined) {
      throw new Error("OWNERSHIP_TRANSFER_NOT_FOUND");
    }
    if (record.version !== command.expectedVersion) {
      throw new Error("OPTIMISTIC_LOCK_FAILED");
    }

    const existingTransfer = await executor
      .select()
      .from(ownershipTransfer)
      .where(eq(ownershipTransfer.id, command.id));
    const transfer = existingTransfer[0];
    if (transfer === undefined) {
      throw new Error("OWNERSHIP_TRANSFER_NOT_FOUND");
    }
    const registrationEvidenceDocumentId =
      command.evidence.registrationEvidenceDocumentId;
    if (record.transfer_status === "COMPLETED") {
      const transferEvidenceDocumentId =
        typeof record.transfer_evidence?.registrationEvidenceDocumentId ===
        "string"
          ? record.transfer_evidence.registrationEvidenceDocumentId
          : null;
      const evidenceDocument = isUuid(registrationEvidenceDocumentId)
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
                on document.id = ${registrationEvidenceDocumentId}::uuid
               and document.person_id = application.applicant_person_id
             where agreement.id = (
               select contract_id from ownership_transfer where id = ${command.id}
             )
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
        transferEvidenceDocumentId === registrationEvidenceDocumentId &&
        record.contract_status === "TRANSFERRED" &&
        record.ownership_holder === "CUSTOMER" &&
        BigInt(record.outstanding_balance_minor_units) === 0n &&
        record.vehicle_status === "TRANSFERRED" &&
        record.registration_number !== null &&
        record.registered_owner === "CUSTOMER" &&
        record.valid_from !== null &&
        record.registration_evidence_document_id ===
          registrationEvidenceDocumentId;
      if (coherent) return transfer;

      const derivable =
        acceptedEvidence &&
        transferEvidenceDocumentId === registrationEvidenceDocumentId &&
        record.contract_status === "SETTLED" &&
        record.ownership_holder === "SOMOCO" &&
        BigInt(record.outstanding_balance_minor_units) === 0n &&
        record.registration_number !== null &&
        record.registered_owner === "SOMOCO" &&
        record.valid_from !== null &&
        (record.registration_evidence_document_id === null ||
          record.registration_evidence_document_id ===
            registrationEvidenceDocumentId);
      if (!derivable)
        throw new Error(
          "LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED",
        );

      const contractTransition = await executor.execute(sql`
        update contract
           set status = 'TRANSFERRED', ownership_holder = 'CUSTOMER',
               version = version + 1, updated_at = ${command.transferredAt}
         where id = (select contract_id from ownership_transfer where id = ${command.id})
           and status = 'SETTLED' and ownership_holder = 'SOMOCO'
           and outstanding_balance_minor_units = 0
      `);
      if ((contractTransition.rowCount ?? 0) !== 1)
        throw new Error(
          "LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED",
        );
      if (record.vehicle_status !== "TRANSFERRED") {
        const vehicleTransition = await executor.execute(sql`
          update vehicle_unit
             set status = 'TRANSFERRED', version = version + 1,
                 updated_at = ${command.transferredAt}
           where id = ${record.vehicle_unit_id}
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
        values (${record.vehicle_unit_id}, ${record.registration_number}, 'CUSTOMER',
                ${record.valid_from}::date, ${record.valid_to}::date,
                ${registrationEvidenceDocumentId}::uuid,
                greatest(now(), ${command.transferredAt}))
      `);
      return transfer;
    }
    if (
      record.contract_status !== "SETTLED" ||
      record.ownership_holder !== "SOMOCO" ||
      BigInt(record.outstanding_balance_minor_units) !== 0n
    ) {
      throw new Error("CONTRACT_NOT_SETTLED");
    }
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

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}
