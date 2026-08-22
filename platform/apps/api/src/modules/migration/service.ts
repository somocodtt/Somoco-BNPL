import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../../../../packages/db/node_modules/drizzle-orm/index.js";
import { enqueueOutbox, withTransaction, type Database } from "@somo/db";
import { getInternalDatabase } from "../../../../../packages/db/src/client.js";
import { getInternalExecutor } from "../../../../../packages/db/src/transaction.js";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export interface LegacyImportRow {
  sourceRecordId: string;
  sourceRowNumber: number;
  customer?: {
    legacyId?: string;
    phoneE164?: string;
    ghanaCard?: string;
    ghanaCardFingerprint?: string;
    fullName?: string;
  };
  guarantor?: { legacyId?: string; phoneE164?: string; ghanaCard?: string };
  contract?: { legacyId?: string; reference?: string };
  vehicle?: { legacyId?: string; vin?: string; chassisNumber?: string };
  currentBalanceMinorUnits: string;
  repaymentHistory?: readonly Record<string, unknown>[];
  attachmentDocumentId?: string;
  [key: string]: unknown;
}

export interface ImportBatchInput {
  source: "LEGACY_EXCEL" | "LEGACY_CSV" | "LEGACY_PAPER";
  sourceBatchId: string;
  sourceFileHash: string;
  templateVersion: string;
  expectedRecords: number;
  controlTotalMinorUnits?: string;
  rows: readonly LegacyImportRow[];
}

export interface MigrationBatchView {
  id: string;
  source: string;
  sourceBatchId: string;
  status: string;
  expectedRecords: number;
  importedRecords: number;
  expectedTotalMinorUnits: string;
  reconciledTotalMinorUnits: string;
  sampleRequired: number;
  samplePassed: number;
  verifiedBy: string | null;
  approvedBy: string | null;
  activatedAt: string | null;
  records: readonly MigrationRecordView[];
}

export interface MigrationRecordView {
  id: string;
  sourceRecordId: string;
  status: string;
  errors: readonly Record<string, unknown>[];
  matchCandidates: readonly unknown[];
  validationOutcomes: readonly unknown[];
  targetId: string | null;
  payloadHash: string | null;
}

export interface MigrationService {
  importBatch(
    input: {
      actor: StaffPrincipal;
      requestId: string;
    } & ImportBatchInput,
  ): Promise<MigrationBatchView>;
  validate(input: {
    batchId: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<MigrationBatchView>;
  verifyBatch(input: {
    batchId: string;
    actor: StaffPrincipal;
    requestId: string;
    sampleRecordIds?: readonly string[];
  }): Promise<MigrationBatchView>;
  approveBatch(input: {
    batchId: string;
    actor: StaffPrincipal;
    requestId: string;
    financialEvidenceHash: string;
  }): Promise<MigrationBatchView>;
  activateBatch(input: {
    batchId: string;
    actor: StaffPrincipal;
    requestId: string;
  }): Promise<MigrationBatchView>;
  listBatches(actor: StaffPrincipal): Promise<readonly MigrationBatchView[]>;
}

export function createMigrationService(options: {
  database: Database;
}): MigrationService {
  return {
    async importBatch(input) {
      requireImportRole(input.actor);
      validateHash(input.sourceFileHash, "MIGRATION_SOURCE_FILE_HASH_INVALID");
      if (input.templateVersion.trim() === "")
        throw new AppError(
          400,
          "MIGRATION_TEMPLATE_REQUIRED",
          "A template version is required.",
        );
      if (input.templateVersion !== "legacy-v1")
        throw new AppError(
          400,
          "MIGRATION_TEMPLATE_UNSUPPORTED",
          "The supplied migration template version is not approved.",
        );
      if (
        !Number.isSafeInteger(input.expectedRecords) ||
        input.expectedRecords < 0
      )
        throw new AppError(
          400,
          "MIGRATION_EXPECTED_RECORDS_INVALID",
          "Expected record count is invalid.",
        );
      if (input.rows.length !== input.expectedRecords)
        throw new AppError(
          400,
          "MIGRATION_RECORD_COUNT_MISMATCH",
          "The record count does not match the declared total.",
        );

      return withTransaction(options.database, async (tx) => {
        const executor = getInternalExecutor(tx);
        const existing = await executor.execute<{
          id: string;
          source_file_hash: string | null;
          template_version: string;
        }>(sql`
          select id, source_file_hash, template_version
            from migration_batch
           where source = ${input.source}
             and source_batch_id = ${input.sourceBatchId}
           for update
        `);
        if (existing.rows[0] !== undefined) {
          const batch = existing.rows[0];
          const prior = await listBatch(tx, batch.id);
          if (
            batch.source_file_hash !== input.sourceFileHash ||
            batch.template_version !== input.templateVersion
          )
            throw new AppError(
              409,
              "MIGRATION_REPLAY_CONFLICT",
              "The source batch key was reused with different file evidence.",
            );
          const priorHashes = new Map(
            prior.records.map((record) => [
              record.sourceRecordId,
              record.payloadHash,
            ]),
          );
          for (const row of input.rows) {
            if (priorHashes.get(row.sourceRecordId) !== payloadHash(row))
              throw new AppError(
                409,
                "MIGRATION_REPLAY_CONFLICT",
                "The source row changed under an existing import key.",
              );
          }
          return prior;
        }

        const batchId = randomUUID();
        const validation = await validateRows(executor, input.rows);
        const declaredTotal =
          input.controlTotalMinorUnits === undefined
            ? validation.totalMinorUnits
            : parseAmount(
                input.controlTotalMinorUnits,
                "MIGRATION_CONTROL_TOTAL_INVALID",
              );
        const controlMismatch = declaredTotal !== validation.totalMinorUnits;
        if (controlMismatch) {
          for (const row of validation.rows) {
            row.errors.push({
              code: "CONTROL_TOTAL_MISMATCH",
              message: "The file control total does not reconcile.",
            });
          }
        }
        const hasInvalid =
          validation.rows.some((row) => row.errors.length > 0) ||
          controlMismatch;
        const batchStatus = hasInvalid ? "QUARANTINED" : "VALIDATED";
        const inserted = await executor.execute<{ id: string }>(sql`
          insert into migration_batch
            (id, source, source_batch_id, source_file_hash, template_version,
             schema_version, status, expected_records, imported_records,
             expected_total_minor_units, reconciled_total_minor_units,
             control_total_hash, uploader_staff_user_id, created_at, updated_at)
          values
            (${batchId}, ${input.source}, ${input.sourceBatchId}, ${input.sourceFileHash},
             ${input.templateVersion}, ${input.templateVersion}, ${batchStatus},
             ${input.expectedRecords}, 0, ${declaredTotal}, ${validation.totalMinorUnits},
             ${sha256(String(declaredTotal))}, ${input.actor.staffUserId}, now(), now())
          on conflict (source, source_batch_id) do nothing
          returning id
        `);
        if (inserted.rows[0] === undefined) {
          const concurrent = await executor.execute<{
            id: string;
            source_file_hash: string | null;
            template_version: string;
          }>(sql`
            select id, source_file_hash, template_version from migration_batch
             where source = ${input.source} and source_batch_id = ${input.sourceBatchId}
          `);
          const batch = concurrent.rows[0];
          if (
            batch === undefined ||
            batch.source_file_hash !== input.sourceFileHash ||
            batch.template_version !== input.templateVersion
          )
            throw new AppError(
              409,
              "MIGRATION_REPLAY_CONFLICT",
              "The source batch key was reused with different file evidence.",
            );
          return listBatch(tx, batch.id);
        }
        for (const row of validation.rows) {
          await executor.execute(sql`
            insert into migration_record
              (id, migration_batch_id, source_record_id, status, payload,
               normalized_row, source_row_number, source_file_hash,
               template_version, payload_hash, amount_minor_units,
               legacy_customer_id, legacy_guarantor_id, legacy_contract_id,
               legacy_vehicle_id, attachment_document_id, attachment_object_key,
               attachment_object_version_id, attachment_object_etag,
               match_candidates, validation_outcomes, errors, created_at)
            values
              (${row.id}, ${batchId}, ${row.sourceRecordId}, ${row.errors.length === 0 ? "VALID" : "INVALID"},
               ${JSON.stringify(row.payload)}::jsonb, ${JSON.stringify(row.normalized)}::jsonb,
               ${row.sourceRowNumber}, ${input.sourceFileHash}, ${input.templateVersion},
               ${row.payloadHash}, ${row.amountMinorUnits}, ${row.legacyCustomerId},
               ${row.legacyGuarantorId}, ${row.legacyContractId}, ${row.legacyVehicleId},
               ${row.attachmentDocumentId}, ${row.attachment?.objectKey ?? null},
               ${row.attachment?.versionId ?? null}, ${row.attachment?.etag ?? null},
               ${JSON.stringify(row.matchCandidates)}::jsonb, ${JSON.stringify(row.validationOutcomes)}::jsonb,
               ${JSON.stringify(row.errors)}::jsonb, now())
          `);
        }
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: batchId,
          action: "MIGRATION_BATCH_IMPORTED",
          actor: input.actor,
          requestId: input.requestId,
          data: {
            source: input.source,
            expectedRecords: input.expectedRecords,
            status: batchStatus,
          },
        });
        return listBatch(tx, batchId);
      });
    },
    async validate(input) {
      requireImportRole(input.actor);
      return withTransaction(options.database, async (tx) => {
        const batch = await getBatch(tx, input.batchId);
        if (batch === null)
          throw new AppError(
            404,
            "MIGRATION_BATCH_NOT_FOUND",
            "Migration batch not found.",
          );
        if (batch.status !== "QUARANTINED") return listBatch(tx, input.batchId);
        const rows = await listRecordRows(tx, input.batchId);
        if (rows.some((row) => row.status === "INVALID"))
          return listBatch(tx, input.batchId);
        await updateBatch(tx, input.batchId, { status: "VALIDATED" });
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          action: "MIGRATION_BATCH_VALIDATED",
          actor: input.actor,
          requestId: input.requestId,
          data: {},
        });
        return listBatch(tx, input.batchId);
      });
    },
    async verifyBatch(input) {
      requireVerificationRole(input.actor);
      return withTransaction(options.database, async (tx) => {
        const batch = await getBatch(tx, input.batchId);
        if (batch === null)
          throw new AppError(
            404,
            "MIGRATION_BATCH_NOT_FOUND",
            "Migration batch not found.",
          );
        if (batch.uploader_staff_user_id === input.actor.staffUserId)
          throw new AppError(
            409,
            "MIGRATION_SEPARATION_REQUIRED",
            "The importer cannot verify the same batch.",
          );
        if (batch.status !== "VALIDATED")
          throw new AppError(
            409,
            "MIGRATION_BATCH_NOT_VALIDATED",
            "The batch must pass validation before verification.",
          );
        const rows = await listRecordRows(tx, input.batchId);
        if (rows.some((row) => row.status !== "VALID"))
          throw new AppError(
            409,
            "MIGRATION_BATCH_QUARANTINED",
            "Every row must be valid before verification.",
          );
        if (input.sampleRecordIds !== undefined) {
          const requestedIds = new Set(input.sampleRecordIds);
          if (
            requestedIds.size !== input.sampleRecordIds.length ||
            input.sampleRecordIds.some(
              (recordId) => !rows.some((row) => row.id === recordId),
            )
          )
            throw new AppError(
              400,
              "MIGRATION_SAMPLE_INVALID",
              "Every requested sample row must belong to the batch exactly once.",
            );
        }
        const requested = input.sampleRecordIds?.length ?? rows.length;
        await updateBatch(tx, input.batchId, {
          status: "VALIDATED",
          verifiedBy: input.actor.staffUserId,
          verifiedAt: new Date(),
          sampleRequired: requested,
          samplePassed: requested,
        });
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          action: "MIGRATION_BATCH_VERIFIED",
          actor: input.actor,
          requestId: input.requestId,
          data: { sampleRequired: requested, samplePassed: requested },
        });
        return listBatch(tx, input.batchId);
      });
    },
    async approveBatch(input) {
      requireFinanceApprovalRole(input.actor);
      validateHash(
        input.financialEvidenceHash,
        "MIGRATION_FINANCIAL_EVIDENCE_INVALID",
      );
      return withTransaction(options.database, async (tx) => {
        const batch = await getBatch(tx, input.batchId);
        if (batch === null)
          throw new AppError(
            404,
            "MIGRATION_BATCH_NOT_FOUND",
            "Migration batch not found.",
          );
        if (
          batch.uploader_staff_user_id === input.actor.staffUserId ||
          batch.verified_by === input.actor.staffUserId
        )
          throw new AppError(
            409,
            "MIGRATION_SEPARATION_REQUIRED",
            "The finance approver must be independent of the importer and verifier.",
          );
        if (batch.status !== "VALIDATED" || batch.verified_by === null)
          throw new AppError(
            409,
            "MIGRATION_VERIFICATION_REQUIRED",
            "A verified batch is required before finance approval.",
          );
        if (
          BigInt(batch.expected_total_minor_units) !==
          BigInt(batch.reconciled_total_minor_units)
        )
          throw new AppError(
            409,
            "MIGRATION_CONTROL_TOTAL_UNRECONCILED",
            "The migration control total has not reconciled.",
          );
        await updateBatch(tx, input.batchId, {
          status: "APPROVED",
          approvedBy: input.actor.staffUserId,
          approvedAt: new Date(),
          financialEvidenceHash: input.financialEvidenceHash,
        });
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          action: "MIGRATION_BATCH_FINANCE_APPROVED",
          actor: input.actor,
          requestId: input.requestId,
          data: { financialEvidenceHash: input.financialEvidenceHash },
        });
        return listBatch(tx, input.batchId);
      });
    },
    async activateBatch(input) {
      requireFinanceApprovalRole(input.actor);
      return withTransaction(options.database, async (tx) => {
        const batch = await getBatch(tx, input.batchId);
        if (batch === null)
          throw new AppError(
            404,
            "MIGRATION_BATCH_NOT_FOUND",
            "Migration batch not found.",
          );
        if (
          batch.status !== "APPROVED" ||
          batch.approved_by !== input.actor.staffUserId
        )
          throw new AppError(
            409,
            "MIGRATION_APPROVAL_REQUIRED",
            "The approved finance command is required for activation.",
          );
        if (
          BigInt(batch.expected_total_minor_units) !==
          BigInt(batch.reconciled_total_minor_units)
        )
          throw new AppError(
            409,
            "MIGRATION_CONTROL_TOTAL_UNRECONCILED",
            "The migration control total has not reconciled.",
          );
        if (batch.sample_passed < batch.sample_required)
          throw new AppError(
            409,
            "MIGRATION_SAMPLE_REQUIRED",
            "The required migration sample has not passed.",
          );
        const executor = getInternalExecutor(tx);
        const rows = await listRecordRows(tx, input.batchId);
        if (rows.some((row) => row.status !== "VALID"))
          throw new AppError(
            409,
            "MIGRATION_BATCH_QUARANTINED",
            "Every row must remain valid before activation.",
          );
        for (const row of rows) {
          const live = await findLiveCollision(executor, row);
          if (live !== null) {
            await updateBatch(tx, input.batchId, { status: "REJECTED" });
            throw new AppError(
              409,
              "MIGRATION_LIVE_RECORD_CONFLICT",
              "A live record appeared before activation; the batch remains inactive.",
            );
          }
        }
        let imported = 0;
        for (const row of rows) {
          const normalized = row.normalized_row as Record<string, unknown>;
          const customer = (normalized.customer ?? {}) as Record<
            string,
            unknown
          >;
          const phone = String(customer.phoneE164 ?? "");
          const fingerprint = String(customer.ghanaCardFingerprint ?? "");
          const personId = randomUUID();
          await executor.execute(sql`
            insert into privacy.person (id, phone_e164, ghana_card_fingerprint)
            values (${personId}, ${phone}, ${fingerprint})
          `);
          const applicationId = randomUUID();
          await executor.execute(sql`
            insert into application (id, applicant_person_id, status)
            values (${applicationId}, ${personId}, 'ACTIVE')
          `);
          await executor.execute(sql`
            update migration_record
               set status = 'IMPORTED', target_type = 'application', target_id = ${applicationId}, activated_at = now()
             where id = ${row.id}
          `);
          imported += 1;
        }
        await updateBatch(tx, input.batchId, {
          status: "IMPORTED",
          importedRecords: imported,
          activatedAt: new Date(),
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "migration.batch.activated",
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          occurredAt: new Date(),
          payload: {
            batchId: input.batchId,
            importedRecords: imported,
            activatedBy: input.actor.staffUserId,
            requestId: input.requestId,
          },
        });
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          action: "MIGRATION_BATCH_ACTIVATED",
          actor: input.actor,
          requestId: input.requestId,
          data: { importedRecords: imported },
        });
        return listBatch(tx, input.batchId);
      });
    },
    async listBatches(actor) {
      requireMigrationReadRole(actor);
      const internal = getInternalDatabase(options.database);
      const rows = await internal.execute<{ id: string }>(
        sql`select id from migration_batch order by created_at desc, id desc limit 1000`,
      );
      return Promise.all(
        rows.rows.map((row) => listBatch(options.database, row.id)),
      );
    },
  };
}

interface ValidatedRow {
  id: string;
  sourceRecordId: string;
  sourceRowNumber: number;
  payload: LegacyImportRow;
  normalized: Record<string, unknown>;
  payloadHash: string;
  amountMinorUnits: bigint;
  legacyCustomerId: string | null;
  legacyGuarantorId: string | null;
  legacyContractId: string | null;
  legacyVehicleId: string | null;
  attachmentDocumentId: string | null;
  attachment: { objectKey: string; versionId: string; etag: string } | null;
  errors: Array<Record<string, unknown>>;
  matchCandidates: unknown[];
  validationOutcomes: unknown[];
}

async function validateRows(
  executor: ReturnType<typeof getInternalExecutor>,
  rows: readonly LegacyImportRow[],
) {
  const seenSource = new Set<string>();
  const seenCard = new Set<string>();
  const seenContract = new Set<string>();
  const seenVehicle = new Set<string>();
  const result: ValidatedRow[] = [];
  let totalMinorUnits = 0n;
  for (const payload of rows) {
    const errors: Array<Record<string, unknown>> = [];
    const sourceRecordId =
      typeof payload.sourceRecordId === "string"
        ? payload.sourceRecordId.trim()
        : "";
    if (sourceRecordId === "" || seenSource.has(sourceRecordId))
      errors.push({
        code: "DUPLICATE_SOURCE_ROW",
        message: "Source row identity is missing or duplicated.",
      });
    seenSource.add(sourceRecordId);
    if (
      !Number.isSafeInteger(payload.sourceRowNumber) ||
      payload.sourceRowNumber < 1
    )
      errors.push({
        code: "SOURCE_ROW_NUMBER_INVALID",
        message: "Source row number is invalid.",
      });
    let amount = 0n;
    try {
      amount = parseAmount(
        payload.currentBalanceMinorUnits,
        "CURRENT_BALANCE_INVALID",
      );
    } catch {
      errors.push({
        code: "CURRENT_BALANCE_INVALID",
        message: "Current balance must be a nonnegative GHS minor-unit amount.",
      });
    }
    totalMinorUnits += amount;
    const customer = payload.customer ?? {};
    const fingerprint = normalizeFingerprint(
      customer.ghanaCardFingerprint ?? customer.ghanaCard,
    );
    if (fingerprint === null)
      errors.push({
        code: "GHANA_CARD_REQUIRED",
        message: "A minimized Ghana Card fingerprint is required.",
      });
    else if (seenCard.has(fingerprint))
      errors.push({
        code: "DUPLICATE_GHANA_CARD",
        message:
          "The Ghana Card identity is duplicated within the source file.",
      });
    else seenCard.add(fingerprint);
    const contractReference = payload.contract?.reference?.trim();
    if (contractReference !== undefined) {
      if (seenContract.has(contractReference))
        errors.push({
          code: "DUPLICATE_CONTRACT_REFERENCE",
          message:
            "The contract reference is duplicated within the source file.",
        });
      seenContract.add(contractReference);
    }
    const vehicle = payload.vehicle ?? {};
    for (const identity of [vehicle.vin, vehicle.chassisNumber].filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    )) {
      if (seenVehicle.has(identity))
        errors.push({
          code: "DUPLICATE_VEHICLE_IDENTIFIER",
          message: "A vehicle identifier is duplicated within the source file.",
        });
      seenVehicle.add(identity);
    }
    let attachment: ValidatedRow["attachment"] = null;
    if (payload.attachmentDocumentId === undefined)
      errors.push({
        code: "ATTACHMENT_REQUIRED",
        message: "One accepted clean legacy attachment is required.",
      });
    else {
      const document = await executor.execute<{
        object_key: string;
        accepted_object_key: string | null;
        accepted_object_version_id: string | null;
        accepted_object_etag: string | null;
      }>(sql`
        select object_key, accepted_object_key, accepted_object_version_id, accepted_object_etag
          from privacy.document
         where id = ${payload.attachmentDocumentId}
           and status = 'ACCEPTED' and malware_scanned = true
         limit 1
      `);
      const bound = document.rows[0];
      if (
        bound === undefined ||
        bound.accepted_object_key === null ||
        bound.accepted_object_version_id === null ||
        bound.accepted_object_etag === null
      )
        errors.push({
          code: "ATTACHMENT_NOT_CLEAN",
          message:
            "The legacy attachment is not an accepted immutable clean document.",
        });
      else
        attachment = {
          objectKey: bound.accepted_object_key,
          versionId: bound.accepted_object_version_id,
          etag: bound.accepted_object_etag,
        };
    }
    const phone = customer.phoneE164?.trim() ?? "";
    if (!/^\+233[1-9][0-9]{8}$/.test(phone))
      errors.push({
        code: "PHONE_INVALID",
        message: "A Ghana E.164 customer phone is required.",
      });
    const normalized = {
      customer: {
        legacyId: customer.legacyId ?? null,
        phoneE164: phone,
        ghanaCardFingerprint: fingerprint,
      },
      guarantor: { legacyId: payload.guarantor?.legacyId ?? null },
      contract: {
        legacyId: payload.contract?.legacyId ?? null,
        reference: contractReference ?? null,
      },
      vehicle: {
        legacyId: vehicle.legacyId ?? null,
        vin: vehicle.vin ?? null,
        chassisNumber: vehicle.chassisNumber ?? null,
      },
      currentBalanceMinorUnits: amount.toString(),
      repaymentHistory: Array.isArray(payload.repaymentHistory)
        ? payload.repaymentHistory
        : [],
    };
    result.push({
      id: randomUUID(),
      sourceRecordId,
      sourceRowNumber: payload.sourceRowNumber,
      payload,
      normalized,
      payloadHash: payloadHash(payload),
      amountMinorUnits: amount,
      legacyCustomerId: customer.legacyId ?? null,
      legacyGuarantorId: payload.guarantor?.legacyId ?? null,
      legacyContractId: payload.contract?.legacyId ?? null,
      legacyVehicleId: vehicle.legacyId ?? null,
      attachmentDocumentId: payload.attachmentDocumentId ?? null,
      attachment,
      errors,
      matchCandidates: [],
      validationOutcomes: errors.map((item) => item.code),
    });
  }
  for (const row of result) {
    const collision = await findLiveCollision(executor, row);
    if (collision !== null) {
      row.matchCandidates.push(collision);
      row.errors.push({
        code: "LIVE_RECORD_COLLISION",
        message:
          "The source row matches an active live record and is quarantined.",
      });
    }
  }
  return { rows: result, totalMinorUnits };
}

async function findLiveCollision(
  executor: ReturnType<typeof getInternalExecutor>,
  row: {
    normalized_row?: unknown;
    normalized?: Record<string, unknown>;
    legacyContractId?: string | null;
    legacyVehicleId?: string | null;
    payload?: LegacyImportRow;
  },
) {
  const normalized =
    row.normalized ??
    (row.normalized_row as Record<string, unknown> | undefined) ??
    {};
  const customer = (normalized.customer ?? {}) as Record<string, unknown>;
  const fingerprint =
    typeof customer.ghanaCardFingerprint === "string"
      ? customer.ghanaCardFingerprint
      : null;
  const contractReference = row.payload?.contract?.reference ?? null;
  const vehicle = row.payload?.vehicle ?? {};
  if (fingerprint !== null) {
    const result = await executor.execute<{ kind: string; id: string }>(
      sql`select 'PERSON' as kind, id from privacy.person where ghana_card_fingerprint = ${fingerprint} limit 1`,
    );
    if (result.rows[0] !== undefined) return result.rows[0];
  }
  if (contractReference !== null) {
    const result = await executor.execute<{ kind: string; id: string }>(
      sql`select 'CONTRACT' as kind, id from contract where reference = ${contractReference} limit 1`,
    );
    if (result.rows[0] !== undefined) return result.rows[0];
  }
  const vehicleValues = [vehicle.vin, vehicle.chassisNumber].filter(
    (value): value is string =>
      typeof value === "string" && value.trim() !== "",
  );
  if (vehicleValues.length > 0) {
    const result = await executor.execute<{ kind: string; id: string }>(
      sql`select 'VEHICLE' as kind, id from vehicle_unit where vin = ${vehicleValues[0]!} or chassis_number = ${vehicleValues[1] ?? vehicleValues[0]!} limit 1`,
    );
    if (result.rows[0] !== undefined) return result.rows[0];
  }
  return null;
}

async function listBatch(
  db: Parameters<typeof getInternalExecutor>[0],
  batchId: string,
): Promise<MigrationBatchView> {
  const batch = await getBatch(db, batchId);
  if (batch === null)
    throw new AppError(
      404,
      "MIGRATION_BATCH_NOT_FOUND",
      "Migration batch not found.",
    );
  const records = await listRecordRows(db, batchId);
  return {
    id: batch.id,
    source: batch.source,
    sourceBatchId: batch.source_batch_id,
    status: batch.status,
    expectedRecords: batch.expected_records,
    importedRecords: batch.imported_records,
    expectedTotalMinorUnits: String(batch.expected_total_minor_units),
    reconciledTotalMinorUnits: String(batch.reconciled_total_minor_units),
    sampleRequired: batch.sample_required,
    samplePassed: batch.sample_passed,
    verifiedBy: batch.verified_by,
    approvedBy: batch.approved_by,
    activatedAt:
      batch.activated_at === null
        ? null
        : new Date(batch.activated_at).toISOString(),
    records: records.map((row) => ({
      id: row.id,
      sourceRecordId: row.source_record_id,
      status: row.status,
      errors: (row.errors as Array<Record<string, unknown>> | null) ?? [],
      matchCandidates: (row.match_candidates as unknown[]) ?? [],
      validationOutcomes: (row.validation_outcomes as unknown[]) ?? [],
      targetId: row.target_id,
      payloadHash: row.payload_hash,
    })) as MigrationRecordView[],
  };
}

async function getBatch(
  db: Parameters<typeof getInternalExecutor>[0],
  batchId: string,
) {
  const executor = getInternalExecutor(db);
  const result = await executor.execute<{
    id: string;
    source: string;
    source_batch_id: string;
    status: string;
    expected_records: number;
    imported_records: number;
    uploader_staff_user_id: string | null;
    verified_by: string | null;
    verified_at: Date | null;
    approved_by: string | null;
    expected_total_minor_units: bigint | string;
    reconciled_total_minor_units: bigint | string;
    sample_required: number;
    sample_passed: number;
    activated_at: Date | null;
  }>(
    sql`select id, source, source_batch_id, status, expected_records, imported_records, uploader_staff_user_id, verified_by, verified_at, approved_by, expected_total_minor_units, reconciled_total_minor_units, sample_required, sample_passed, activated_at from migration_batch where id = ${batchId} for update`,
  );
  return result.rows[0] ?? null;
}

async function listRecordRows(
  db: Parameters<typeof getInternalExecutor>[0],
  batchId: string,
) {
  const executor = getInternalExecutor(db);
  const result = await executor.execute<{
    id: string;
    source_record_id: string;
    status: string;
    payload: LegacyImportRow;
    normalized_row: Record<string, unknown>;
    payload_hash: string | null;
    errors: unknown[] | null;
    match_candidates: unknown[] | null;
    validation_outcomes: unknown[] | null;
    target_id: string | null;
  }>(
    sql`select id, source_record_id, status, payload, normalized_row, payload_hash, errors, match_candidates, validation_outcomes, target_id from migration_record where migration_batch_id = ${batchId} order by source_row_number asc nulls last, id asc`,
  );
  return result.rows;
}

async function updateBatch(
  db: Parameters<typeof getInternalExecutor>[0],
  batchId: string,
  fields: Record<string, unknown>,
) {
  const executor = getInternalExecutor(db);
  const assignments = [];
  if ("status" in fields) assignments.push(sql`status = ${fields.status}`);
  if ("importedRecords" in fields)
    assignments.push(sql`imported_records = ${fields.importedRecords}`);
  if ("verifiedBy" in fields)
    assignments.push(sql`verified_by = ${fields.verifiedBy}`);
  if ("verifiedAt" in fields)
    assignments.push(sql`verified_at = ${fields.verifiedAt}`);
  if ("approvedBy" in fields)
    assignments.push(sql`approved_by = ${fields.approvedBy}`);
  if ("approvedAt" in fields)
    assignments.push(sql`approved_at = ${fields.approvedAt}`);
  if ("financialEvidenceHash" in fields)
    assignments.push(
      sql`financial_evidence_hash = ${fields.financialEvidenceHash}`,
    );
  if ("sampleRequired" in fields)
    assignments.push(sql`sample_required = ${fields.sampleRequired}`);
  if ("samplePassed" in fields)
    assignments.push(sql`sample_passed = ${fields.samplePassed}`);
  if ("activatedAt" in fields)
    assignments.push(sql`activated_at = ${fields.activatedAt}`);
  if (assignments.length === 0) return;
  await executor.execute(
    sql`update migration_batch set ${sql.join(assignments, sql`, `)}, updated_at = now() where id = ${batchId}`,
  );
}

async function appendAudit(
  db: Parameters<typeof getInternalExecutor>[0],
  input: {
    aggregateType: string;
    aggregateId: string;
    action: string;
    actor: StaffPrincipal;
    requestId: string;
    data: Record<string, unknown>;
  },
) {
  const executor = getInternalExecutor(db);
  await executor.execute(
    sql`insert into audit_event (aggregate_type, aggregate_id, action, actor_staff_user_id, request_id, data, occurred_at) values (${input.aggregateType}, ${input.aggregateId}, ${input.action}, ${input.actor.staffUserId}, ${input.requestId}, ${JSON.stringify(input.data)}::jsonb, now())`,
  );
}

function requireImportRole(actor: StaffPrincipal): void {
  if (
    !actor.roles.some((role) =>
      [
        "SYSTEM_ADMIN",
        "FINANCE_OFFICER",
        "CFO",
        "VERIFICATION_OFFICER",
        "MIGRATION_IMPORTER",
      ].includes(role),
    )
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Migration access is not permitted for this role.",
    );
}
function requireMigrationReadRole(actor: StaffPrincipal): void {
  if (
    !actor.roles.some((role) =>
      [
        "SYSTEM_ADMIN",
        "FINANCE_OFFICER",
        "CFO",
        "VERIFICATION_OFFICER",
        "MIGRATION_IMPORTER",
        "COMPLIANCE_AUDITOR",
      ].includes(role),
    )
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Migration access is not permitted for this role.",
    );
}
function requireVerificationRole(actor: StaffPrincipal): void {
  if (!actor.roles.some((role) => ["VERIFICATION_OFFICER"].includes(role)))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Migration verification authority is required.",
    );
}
function requireFinanceApprovalRole(actor: StaffPrincipal): void {
  if (!actor.roles.some((role) => ["CFO", "FINANCE_OFFICER"].includes(role)))
    throw new AppError(
      403,
      "FORBIDDEN",
      "Finance migration approval authority is required.",
    );
}
function validateHash(value: string, code: string): void {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new AppError(400, code, "A SHA-256 evidence hash is required.");
}
function parseAmount(value: string, code: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
    throw new AppError(
      400,
      code,
      "Amount must be a nonnegative integer minor-unit string.",
    );
  return BigInt(value);
}
function normalizeFingerprint(value: string | undefined): string | null {
  if (value === undefined || value.trim() === "") return null;
  return /^[0-9a-f]{64}$/.test(value)
    ? value
    : sha256(value.trim().toUpperCase());
}
function payloadHash(value: unknown): string {
  return sha256(canonicalJson(value));
}
function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
