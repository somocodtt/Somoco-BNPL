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
    dateOfBirth?: string;
  };
  applicant?: {
    legacyId?: string;
    fullName?: string;
    phoneE164?: string;
    ghanaCardFingerprint?: string;
    dateOfBirth?: string;
  };
  guarantor?: {
    legacyId?: string;
    fullName?: string;
    phoneE164?: string;
    ghanaCard?: string;
    ghanaCardFingerprint?: string;
    dateOfBirth?: string;
  };
  contract?: {
    legacyId?: string;
    reference?: string;
    startDate?: string;
    endDate?: string;
    totalMinorUnits?: string;
    principalMinorUnits?: string;
    openingBalanceMinorUnits?: string;
  };
  vehicle?: {
    legacyId?: string;
    vin?: string;
    chassisNumber?: string;
    model?: string;
  };
  repaymentFrequency?: "WEEKLY" | "MONTHLY" | string;
  tenureMonths?: number | string;
  arrearsMinorUnits?: string;
  repayment_history?: readonly Record<string, unknown>[];
  arrears_minor_units?: string;
  arrearsAsOfDate?: string;
  arrears_as_of_date?: string;
  totalPaidMinorUnits?: string;
  total_paid_minor_units?: string;
  repayment_frequency?: string;
  tenure_months?: number | string;
  schedule?: { frequency?: string; tenureMonths?: number | string };
  currentBalanceMinorUnits: string;
  repaymentHistory?: readonly Record<string, unknown>[];
  installmentSchedule?: readonly Record<string, unknown>[];
  installment_schedule_json?: string;
  attachmentDocumentId?: string;
  [key: string]: unknown;
}

export interface ImportBatchInput {
  source: "LEGACY_EXCEL" | "LEGACY_CSV" | "LEGACY_PAPER";
  sourceBatchId: string;
  sourceFileHash: string;
  templateVersion: string;
  expectedRecords: number;
  sampleRequired?: number;
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
  sampleEvidence: readonly {
    recordId: string;
    verifierStaffUserId: string;
    verifiedAt: string;
    result: string;
  }[];
  records: readonly MigrationRecordView[];
  events: readonly MigrationEventView[];
}

export interface MigrationEventView {
  id: string;
  eventKey: string;
  eventType: string;
  reasonCode: string | null;
  data: Record<string, unknown>;
  createdAt: string;
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
      const configuredSample =
        input.expectedRecords === 0
          ? 0
          : (input.sampleRequired ?? Math.min(3, input.expectedRecords));
      if (
        !Number.isSafeInteger(configuredSample) ||
        (input.expectedRecords > 0 && configuredSample < 1) ||
        configuredSample > input.expectedRecords
      )
        throw new AppError(
          400,
          "MIGRATION_SAMPLE_CONFIGURATION_INVALID",
          "A nonzero sample requirement within the batch size is required.",
        );

      return withTransaction(options.database, async (tx) => {
        const executor = getInternalExecutor(tx);
        await executor.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${input.sourceFileHash}:${input.templateVersion}`}, 0))`,
        );
        const fingerprint = batchFingerprint({
          source: input.source,
          sourceBatchId: input.sourceBatchId,
          sourceFileHash: input.sourceFileHash,
          templateVersion: input.templateVersion,
          expectedRecords: input.expectedRecords,
          sampleRequired: configuredSample,
          controlTotalMinorUnits: input.controlTotalMinorUnits ?? null,
          rows: input.rows,
        });
        const sameFile = await executor.execute<{
          id: string;
          source_batch_id: string;
          batch_fingerprint: string | null;
        }>(sql`
          select id, source_batch_id, batch_fingerprint
            from migration_batch
           where source_file_hash = ${input.sourceFileHash}
             and template_version = ${input.templateVersion}
           order by created_at asc, id asc
           limit 1
           for update
        `);
        if (sameFile.rows[0] !== undefined) {
          if (
            sameFile.rows[0].batch_fingerprint === fingerprint &&
            sameFile.rows[0].source_batch_id === input.sourceBatchId
          )
            return listBatch(tx, sameFile.rows[0].id);
          throw new AppError(
            409,
            "MIGRATION_REPLAY_CONFLICT",
            "The source file evidence was reused with a different normalized row set.",
          );
        }
        const existing = await executor.execute<{
          id: string;
          source_file_hash: string | null;
          template_version: string;
          batch_fingerprint: string | null;
        }>(sql`
          select id, source_file_hash, template_version, batch_fingerprint
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
            batch.template_version !== input.templateVersion ||
            batch.batch_fingerprint !== fingerprint
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
            if (priorHashes.get(sourceRecordIdOf(row)) !== payloadHash(row))
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
             schema_version, batch_fingerprint, status, expected_records, imported_records,
             expected_total_minor_units, reconciled_total_minor_units,
             control_total_hash, sample_required, uploader_staff_user_id, created_at, updated_at)
          values
            (${batchId}, ${input.source}, ${input.sourceBatchId}, ${input.sourceFileHash},
             ${input.templateVersion}, ${input.templateVersion}, ${fingerprint}, ${batchStatus},
             ${input.expectedRecords}, 0, ${declaredTotal}, ${validation.totalMinorUnits},
             ${sha256(String(declaredTotal))}, ${configuredSample}, ${input.actor.staffUserId}, now(), now())
          on conflict (source, source_batch_id) do nothing
          returning id
        `);
        if (inserted.rows[0] === undefined) {
          const concurrent = await executor.execute<{
            id: string;
            source_file_hash: string | null;
            template_version: string;
            batch_fingerprint: string | null;
          }>(sql`
            select id, source_file_hash, template_version, batch_fingerprint from migration_batch
             where source = ${input.source} and source_batch_id = ${input.sourceBatchId}
          `);
          const batch = concurrent.rows[0];
          if (
            batch === undefined ||
            batch.source_file_hash !== input.sourceFileHash ||
            batch.template_version !== input.templateVersion ||
            batch.batch_fingerprint !== fingerprint
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
               template_version, payload_hash, row_fingerprint, amount_minor_units,
               legacy_customer_id, legacy_guarantor_id, legacy_contract_id,
               legacy_vehicle_id, attachment_document_id, attachment_object_key,
               attachment_object_version_id, attachment_object_etag,
               match_candidates, validation_outcomes, errors, created_at)
            values
              (${row.id}, ${batchId}, ${row.sourceRecordId}, ${row.errors.length === 0 ? "VALID" : "INVALID"},
               ${JSON.stringify(row.payload)}::jsonb, ${JSON.stringify(row.normalized)}::jsonb,
               ${row.sourceRowNumber}, ${input.sourceFileHash}, ${input.templateVersion},
               ${row.payloadHash}, ${row.rowFingerprint}, ${row.amountMinorUnits}, ${row.legacyCustomerId},
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
        await appendMigrationEvent(tx, {
          batchId,
          eventKey: `migration:${batchId}:IMPORTED`,
          eventType: "IMPORTED",
          actor: input.actor,
          requestId: input.requestId,
          data: { source: input.source, status: batchStatus },
        });
        await appendBatchTransition(tx, {
          batchId,
          eventKey: `migration:${batchId}:IMPORTED`,
          eventType: "IMPORTED",
          actor: input.actor,
          requestId: input.requestId,
          fields: { status: batchStatus },
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
        await appendBatchTransition(tx, {
          batchId: input.batchId,
          eventKey: `migration:${input.batchId}:VALIDATED`,
          eventType: "VALIDATED",
          actor: input.actor,
          requestId: input.requestId,
          fields: { status: "VALIDATED" },
        });
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          action: "MIGRATION_BATCH_VALIDATED",
          actor: input.actor,
          requestId: input.requestId,
          data: {},
        });
        await appendMigrationEvent(tx, {
          batchId: input.batchId,
          eventKey: `migration:${input.batchId}:VALIDATED`,
          eventType: "VALIDATED",
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
        if (batch.expected_records > 0 && batch.sample_required < 1)
          throw new AppError(
            409,
            "MIGRATION_SAMPLE_REQUIRED",
            "A non-empty batch must have a configured independent sample.",
          );
        const rows = await listRecordRows(tx, input.batchId);
        if (rows.some((row) => row.status !== "VALID"))
          throw new AppError(
            409,
            "MIGRATION_BATCH_QUARANTINED",
            "Every row must be valid before verification.",
          );
        if (input.sampleRecordIds === undefined)
          throw new AppError(
            409,
            "MIGRATION_SAMPLE_REQUIRED",
            "The verifier must select the configured sample rows.",
          );
        const requestedIds = new Set(input.sampleRecordIds);
        if (input.sampleRecordIds.length !== batch.sample_required)
          throw new AppError(
            409,
            "MIGRATION_SAMPLE_REQUIRED",
            "The verifier must select exactly the configured sample size.",
          );
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
        const requested = input.sampleRecordIds.length;
        if (batch.expected_records > 0 && requested < batch.sample_required)
          throw new AppError(
            409,
            "MIGRATION_SAMPLE_REQUIRED",
            "The configured non-empty sample must be independently evidenced.",
          );
        for (const recordId of input.sampleRecordIds) {
          const row = rows.find((candidate) => candidate.id === recordId);
          const existing = await getInternalExecutor(tx).execute<{
            verifier_staff_user_id: string;
            result: string;
            verification_command_id: string | null;
          }>(sql`
            select verifier_staff_user_id, result, verification_command_id
              from migration_sample_evidence
             where migration_batch_id = ${input.batchId}
               and migration_record_id = ${recordId}
             for update
          `);
          const prior = existing.rows[0];
          if (prior?.result === "FAIL")
            throw new AppError(
              409,
              "MIGRATION_SAMPLE_PREVIOUS_FAIL",
              "A previously failed sample cannot be auto-passed.",
            );
          if (
            prior !== undefined &&
            (prior.verifier_staff_user_id !== input.actor.staffUserId ||
              prior.verification_command_id !== input.requestId)
          )
            throw new AppError(
              409,
              "MIGRATION_SAMPLE_EVIDENCE_CONFLICT",
              "Existing sample evidence does not match this verification command.",
            );
          await getInternalExecutor(tx).execute(sql`
            insert into migration_sample_evidence
              (migration_batch_id, migration_record_id, verifier_staff_user_id,
               verified_at, result, verification_command_id, evidence_hash)
            values
              (${input.batchId}, ${recordId}, ${input.actor.staffUserId}, now(),
               'PASS', ${input.requestId}, ${row?.payload_hash ?? null})
            on conflict (migration_batch_id, migration_record_id) do nothing
          `);
        }
        await appendBatchTransition(tx, {
          batchId: input.batchId,
          eventKey: `migration:${input.batchId}:SAMPLED:${input.actor.staffUserId}`,
          eventType: "SAMPLED",
          actor: input.actor,
          requestId: input.requestId,
          fields: {
            status: "VALIDATED",
            verifiedBy: input.actor.staffUserId,
            verifiedAt: new Date(),
            samplePassed: requested,
          },
        });
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          action: "MIGRATION_BATCH_VERIFIED",
          actor: input.actor,
          requestId: input.requestId,
          data: { sampleRequired: requested, samplePassed: requested },
        });
        await appendMigrationEvent(tx, {
          batchId: input.batchId,
          eventKey: `migration:${input.batchId}:SAMPLED:${input.actor.staffUserId}`,
          eventType: "SAMPLED",
          actor: input.actor,
          requestId: input.requestId,
          data: {
            sampleRequired: batch.sample_required,
            samplePassed: requested,
          },
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
        if (batch.expected_records > 0 && batch.sample_required < 1)
          throw new AppError(
            409,
            "MIGRATION_SAMPLE_REQUIRED",
            "A non-empty batch must have a configured independent sample.",
          );
        if (
          batch.expected_records > 0 &&
          batch.sample_passed < batch.sample_required
        )
          throw new AppError(
            409,
            "MIGRATION_SAMPLE_REQUIRED",
            "A non-empty independently verified sample is required before finance approval.",
          );
        await appendBatchTransition(tx, {
          batchId: input.batchId,
          eventKey: `migration:${input.batchId}:APPROVED`,
          eventType: "APPROVED",
          actor: input.actor,
          requestId: input.requestId,
          fields: {
            status: "APPROVED",
            approvedBy: input.actor.staffUserId,
            approvedAt: new Date(),
            financialEvidenceHash: input.financialEvidenceHash,
          },
        });
        await appendAudit(tx, {
          aggregateType: "migration_batch",
          aggregateId: input.batchId,
          action: "MIGRATION_BATCH_FINANCE_APPROVED",
          actor: input.actor,
          requestId: input.requestId,
          data: { financialEvidenceHash: input.financialEvidenceHash },
        });
        await appendMigrationEvent(tx, {
          batchId: input.batchId,
          eventKey: `migration:${input.batchId}:APPROVED`,
          eventType: "APPROVED",
          actor: input.actor,
          requestId: input.requestId,
          data: { financialEvidenceHash: input.financialEvidenceHash },
        });
        return listBatch(tx, input.batchId);
      });
    },
    async activateBatch(input) {
      requireFinanceApprovalRole(input.actor);
      try {
        return await withTransaction(options.database, async (tx) => {
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
          if (batch.expected_records > 0 && batch.sample_required < 1)
            throw new AppError(
              409,
              "MIGRATION_SAMPLE_REQUIRED",
              "A non-empty batch must have a configured independent sample.",
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
              throw new AppError(
                409,
                "MIGRATION_LIVE_RECORD_CONFLICT",
                "A live record appeared before activation; the batch remains inactive.",
              );
            }
          }
          if (rows.length > 0)
            throw new AppError(
              409,
              "MIGRATION_COMPLETE_GRAPH_REQUIRED",
              "Legacy rows remain quarantined until the complete customer, guarantor, vehicle, contract, schedule, ledger, and repayment graph is validated.",
            );
          const imported = 0;
          await appendBatchTransition(tx, {
            batchId: input.batchId,
            eventKey: `migration:${input.batchId}:ACTIVATED`,
            eventType: "ACTIVATED",
            actor: input.actor,
            requestId: input.requestId,
            fields: {
              status: "IMPORTED",
              importedRecords: imported,
              activatedAt: new Date(),
            },
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
          await appendMigrationEvent(tx, {
            batchId: input.batchId,
            eventKey: `migration:${input.batchId}:ACTIVATED`,
            eventType: "ACTIVATED",
            actor: input.actor,
            requestId: input.requestId,
            data: { importedRecords: imported },
          });
          return listBatch(tx, input.batchId);
        });
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === "MIGRATION_LIVE_RECORD_CONFLICT" ||
            error.code === "MIGRATION_COMPLETE_GRAPH_REQUIRED")
        ) {
          await withTransaction(options.database, async (tx) => {
            const batch = await getBatch(tx, input.batchId);
            if (batch === null || batch.status !== "APPROVED") return;
            await appendBatchTransition(tx, {
              batchId: input.batchId,
              eventKey: `migration:${input.batchId}:QUARANTINED:${error.code}`,
              eventType: "QUARANTINED",
              actor: input.actor,
              requestId: input.requestId,
              reasonCode: error.code,
              fields: { status: "QUARANTINED" },
            });
            await appendMigrationEvent(tx, {
              batchId: input.batchId,
              eventKey: `migration:${input.batchId}:QUARANTINED:${error.code}`,
              eventType: "QUARANTINED",
              actor: input.actor,
              requestId: input.requestId,
              reasonCode: error.code,
              data: { reason: error.publicDetail },
            });
            await appendAudit(tx, {
              aggregateType: "migration_batch",
              aggregateId: input.batchId,
              action: "MIGRATION_BATCH_ACTIVATION_QUARANTINED",
              actor: input.actor,
              requestId: input.requestId,
              data: { reasonCode: error.code },
            });
          });
        }
        throw error;
      }
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
  rowFingerprint: string;
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
  const seenGuarantorCard = new Set<string>();
  const seenContract = new Set<string>();
  const seenVehicle = new Set<string>();
  const result: ValidatedRow[] = [];
  let totalMinorUnits = 0n;
  for (const [rowIndex, payload] of rows.entries()) {
    const errors: Array<Record<string, unknown>> = [];
    const suppliedSourceRecordId = sourceRecordIdOf(payload);
    const duplicateSourceRecordId =
      suppliedSourceRecordId !== "" && seenSource.has(suppliedSourceRecordId);
    const sourceRecordId =
      suppliedSourceRecordId === "" || duplicateSourceRecordId
        ? `__invalid-source-row-${rowIndex + 1}`
        : suppliedSourceRecordId;
    const suppliedSourceRowNumber =
      payload.sourceRowNumber ?? numberField(payload, "source_row_number");
    if (suppliedSourceRecordId === "" || duplicateSourceRecordId)
      errors.push({
        code: "DUPLICATE_SOURCE_ROW",
        message: "Source row identity is missing or duplicated.",
      });
    seenSource.add(suppliedSourceRecordId);
    if (
      !Number.isSafeInteger(suppliedSourceRowNumber) ||
      suppliedSourceRowNumber < 1
    )
      errors.push({
        code: "SOURCE_ROW_NUMBER_INVALID",
        message: "Source row number is invalid.",
      });
    let amount = 0n;
    try {
      amount = parseAmount(
        payload.currentBalanceMinorUnits ??
          stringField(payload, "current_balance_minor_units") ??
          "",
        "CURRENT_BALANCE_INVALID",
      );
    } catch {
      errors.push({
        code: "CURRENT_BALANCE_INVALID",
        message: "Current balance must be a nonnegative GHS minor-unit amount.",
      });
    }
    totalMinorUnits += amount;
    const customer = applicantFromPayload(payload);
    const guarantor = guarantorFromPayload(payload);
    const contract = contractFromPayload(payload);
    const vehicle = vehicleFromPayload(payload);
    const contractTotalValue =
      contract.totalMinorUnits ??
      stringField(
        payload,
        "contractTotalMinorUnits",
        "contract_total_minor_units",
      );
    const principalValue =
      contract.principalMinorUnits ??
      stringField(payload, "principalMinorUnits", "principal_minor_units");
    const openingBalanceValue =
      contract.openingBalanceMinorUnits ??
      stringField(
        payload,
        "openingBalanceMinorUnits",
        "opening_balance_minor_units",
      );
    const totalPaidValue =
      payload.totalPaidMinorUnits ??
      stringField(payload, "total_paid_minor_units");
    const arrearsAsOfDate =
      payload.arrearsAsOfDate ?? stringField(payload, "arrears_as_of_date");
    const repaymentFrequency = String(
      payload.repaymentFrequency ??
        payload.schedule?.frequency ??
        payload.repayment_frequency ??
        "",
    ).toUpperCase();
    const tenureValue =
      payload.tenureMonths ??
      payload.tenure_months ??
      payload.schedule?.tenureMonths;
    const arrearsValue =
      payload.arrearsMinorUnits ?? payload.arrears_minor_units;
    const repaymentHistory = parseRepaymentHistory(
      payload.repaymentHistory ??
        payload.repayment_history ??
        stringField(payload, "repaymentHistoryJson", "repayment_history_json"),
    );
    const installmentScheduleInput =
      payload.installmentSchedule ??
      stringField(
        payload,
        "installmentScheduleJson",
        "installment_schedule_json",
      );
    const installmentSchedule = parseInstallmentSchedule(
      installmentScheduleInput,
    );
    if (!customer.legacyId?.trim())
      errors.push({
        code: "APPLICANT_LEGACY_ID_REQUIRED",
        message: "An applicant legacy identifier is required.",
      });
    if (!customer.fullName?.trim())
      errors.push({
        code: "APPLICANT_NAME_REQUIRED",
        message: "An applicant full name is required.",
      });
    if (!isIsoCalendarDate(customer.dateOfBirth))
      errors.push({
        code: "APPLICANT_DATE_OF_BIRTH_INVALID",
        message:
          "An applicant date of birth must be a valid ISO calendar date.",
      });
    if (!guarantor.legacyId?.trim())
      errors.push({
        code: "GUARANTOR_LEGACY_ID_REQUIRED",
        message: "A guarantor legacy identifier is required.",
      });
    if (!guarantor.fullName?.trim())
      errors.push({
        code: "GUARANTOR_NAME_REQUIRED",
        message: "A guarantor full name is required.",
      });
    if (!isIsoCalendarDate(guarantor.dateOfBirth))
      errors.push({
        code: "GUARANTOR_DATE_OF_BIRTH_INVALID",
        message: "A guarantor date of birth must be a valid ISO calendar date.",
      });
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
    const guarantorFingerprint = normalizeFingerprint(
      guarantor.ghanaCardFingerprint ?? guarantor.ghanaCard,
    );
    if (guarantorFingerprint === null)
      errors.push({
        code: "GUARANTOR_GHANA_CARD_REQUIRED",
        message: "A guarantor Ghana Card fingerprint is required.",
      });
    else if (seenGuarantorCard.has(guarantorFingerprint))
      errors.push({
        code: "DUPLICATE_GUARANTOR_GHANA_CARD",
        message:
          "The guarantor Ghana Card is duplicated within the source file.",
      });
    else seenGuarantorCard.add(guarantorFingerprint);
    const contractReference = contract.reference?.trim();
    if (contractReference === undefined || contractReference === "")
      errors.push({
        code: "CONTRACT_REFERENCE_REQUIRED",
        message: "A legacy contract reference is required.",
      });
    else {
      if (seenContract.has(contractReference))
        errors.push({
          code: "DUPLICATE_CONTRACT_REFERENCE",
          message:
            "The contract reference is duplicated within the source file.",
        });
      seenContract.add(contractReference);
    }
    let contractTotal = 0n;
    let principal = 0n;
    let openingBalance = 0n;
    let totalPaid = 0n;
    try {
      contractTotal = parseRequiredAmount(
        contractTotalValue,
        "CONTRACT_TOTAL_REQUIRED",
      );
    } catch {
      errors.push({
        code: "CONTRACT_TOTAL_REQUIRED",
        message: "An explicit contract total is required.",
      });
    }
    try {
      principal = parseRequiredAmount(principalValue, "PRINCIPAL_REQUIRED");
    } catch {
      errors.push({
        code: "PRINCIPAL_REQUIRED",
        message: "An explicit principal amount is required.",
      });
    }
    try {
      openingBalance = parseRequiredAmount(
        openingBalanceValue,
        "OPENING_BALANCE_REQUIRED",
      );
    } catch {
      errors.push({
        code: "OPENING_BALANCE_REQUIRED",
        message: "An explicit opening balance is required.",
      });
    }
    try {
      totalPaid = parseRequiredAmount(totalPaidValue, "TOTAL_PAID_REQUIRED");
    } catch {
      errors.push({
        code: "TOTAL_PAID_REQUIRED",
        message: "An explicit net paid total is required.",
      });
    }
    if (!contract.legacyId?.trim())
      errors.push({
        code: "CONTRACT_LEGACY_ID_REQUIRED",
        message: "A legacy contract identifier is required.",
      });
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
    if (!vehicle.vin?.trim() && !vehicle.chassisNumber?.trim())
      errors.push({
        code: "VEHICLE_IDENTIFIER_REQUIRED",
        message: "A Somoco vehicle VIN or chassis number is required.",
      });
    if (!vehicle.legacyId?.trim())
      errors.push({
        code: "VEHICLE_LEGACY_ID_REQUIRED",
        message: "A legacy vehicle identifier is required.",
      });
    if (!vehicle.model?.trim())
      errors.push({
        code: "VEHICLE_MODEL_REQUIRED",
        message: "A Somoco vehicle model is required.",
      });
    const guarantorPhone = guarantor.phoneE164?.trim() ?? "";
    if (!/^\+233[1-9][0-9]{8}$/.test(guarantorPhone))
      errors.push({
        code: "GUARANTOR_PHONE_INVALID",
        message: "A Ghana E.164 guarantor phone is required.",
      });
    for (const [code, value] of [
      ["CONTRACT_START_DATE_INVALID", contract.startDate],
      ["CONTRACT_END_DATE_INVALID", contract.endDate],
    ] as const) {
      if (!isIsoCalendarDate(value))
        errors.push({
          code,
          message: "Contract dates must be valid ISO calendar dates.",
        });
    }
    if (repaymentFrequency !== "WEEKLY" && repaymentFrequency !== "MONTHLY")
      errors.push({
        code: "REPAYMENT_FREQUENCY_INVALID",
        message: "Repayment frequency must be WEEKLY or MONTHLY.",
      });
    const tenure = Number(tenureValue);
    if (![6, 8, 12, 24, 36, 48].includes(tenure))
      errors.push({
        code: "TENURE_INVALID",
        message: "Tenure must be one of 6, 8, 12, 24, 36, or 48 months.",
      });
    if (
      isIsoCalendarDate(contract.startDate) &&
      isIsoCalendarDate(contract.endDate) &&
      [6, 8, 12, 24, 36, 48].includes(tenure) &&
      contract.endDate! !== addMonths(contract.startDate!, tenure)
    )
      errors.push({
        code: "TENURE_DATE_RANGE_INVALID",
        message: "The contract dates must match the supplied tenure.",
      });
    let arrears = 0n;
    if (typeof arrearsValue !== "string")
      errors.push({
        code: "ARREARS_REQUIRED",
        message: "A reconciled arrears amount is required.",
      });
    else {
      try {
        arrears = parseAmount(arrearsValue, "ARREARS_INVALID");
      } catch {
        errors.push({
          code: "ARREARS_INVALID",
          message: "Arrears must be a nonnegative minor-unit amount.",
        });
      }
    }
    if (!Array.isArray(repaymentHistory))
      errors.push({
        code: "REPAYMENT_HISTORY_REQUIRED",
        message:
          "A repayment history array is required, including an empty array when none exists.",
      });
    else
      for (const code of repaymentHistoryValidationErrors(repaymentHistory))
        errors.push({
          code,
          message:
            "Repayment history contains an invalid transaction invariant.",
        });
    const rawSchedule = parseJsonArray(installmentScheduleInput);
    if (
      Array.isArray(rawSchedule) &&
      rawSchedule.some((entry, index) => {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry))
          return false;
        const value = entry as Record<string, unknown>;
        const previous = rawSchedule[index - 1];
        const previousDate =
          typeof previous === "object" &&
          previous !== null &&
          !Array.isArray(previous) &&
          typeof (previous as Record<string, unknown>).dueDate === "string"
            ? String((previous as Record<string, unknown>).dueDate)
            : null;
        return (
          value.number !== index + 1 ||
          (previousDate !== null && String(value.dueDate) <= previousDate)
        );
      })
    )
      errors.push({
        code: "INSTALLMENT_SCHEDULE_ORDER_INVALID",
        message: "Installment numbers and due dates must be strictly ordered.",
      });
    if (!Array.isArray(installmentSchedule) || installmentSchedule.length === 0)
      errors.push({
        code: "INSTALLMENT_SCHEDULE_REQUIRED",
        message:
          "At least one reconciled installment schedule entry is required.",
      });
    else {
      const rawSchedule = parseJsonArray(installmentScheduleInput);
      if (
        Array.isArray(rawSchedule) &&
        rawSchedule.some((entry, index) => {
          if (
            typeof entry !== "object" ||
            entry === null ||
            Array.isArray(entry)
          )
            return false;
          const value = entry as Record<string, unknown>;
          const previous = rawSchedule[index - 1];
          const previousDate =
            typeof previous === "object" &&
            previous !== null &&
            !Array.isArray(previous) &&
            typeof (previous as Record<string, unknown>).dueDate === "string"
              ? String((previous as Record<string, unknown>).dueDate)
              : null;
          return (
            value.number !== index + 1 ||
            (previousDate !== null && String(value.dueDate) <= previousDate)
          );
        })
      )
        errors.push({
          code: "INSTALLMENT_SCHEDULE_ORDER_INVALID",
          message:
            "Installment numbers and due dates must be strictly ordered.",
        });
      const scheduleTotal = installmentSchedule.reduce(
        (total, entry) => total + BigInt(String(entry.amountMinorUnits)),
        0n,
      );
      if (scheduleTotal <= 0n)
        errors.push({
          code: "INSTALLMENT_SCHEDULE_TOTAL_INVALID",
          message: "The installment schedule total must be positive.",
        });
      if (
        isIsoCalendarDate(contract.startDate) &&
        isIsoCalendarDate(contract.endDate) &&
        installmentSchedule.some(
          (entry) =>
            String(entry.dueDate) < contract.startDate! ||
            String(entry.dueDate) >
              (repaymentFrequency === "WEEKLY"
                ? addDays(contract.endDate!, 6)
                : contract.endDate!),
        )
      )
        errors.push({
          code: "INSTALLMENT_DATE_OUT_OF_RANGE",
          message:
            "Installment due dates must fall within the contract maturity window.",
        });
      for (const entry of installmentSchedule) {
        const amountDue = BigInt(String(entry.amountMinorUnits));
        const paid = BigInt(String(entry.paidAmountMinorUnits ?? "0"));
        if (entry.status === "PAID" && paid !== amountDue)
          errors.push({
            code: "INSTALLMENT_PAID_AMOUNT_MISMATCH",
            message: "A PAID installment must be fully paid.",
          });
        if (entry.status === "PARTIAL" && (paid <= 0n || paid >= amountDue))
          errors.push({
            code: "INSTALLMENT_PARTIAL_AMOUNT_INVALID",
            message: "A PARTIAL installment must be partly paid.",
          });
        if (
          ["DUE", "MISSED", "PENDING", "UNPAID", "WAIVED"].includes(
            String(entry.status),
          ) &&
          paid !== 0n
        )
          errors.push({
            code: "INSTALLMENT_UNPAID_AMOUNT_MISMATCH",
            message: "An unpaid or waived installment must have no payment.",
          });
      }
      if (
        isIsoCalendarDate(contract.startDate) &&
        isIsoCalendarDate(contract.endDate) &&
        [6, 8, 12, 24, 36, 48].includes(tenure) &&
        installmentSchedule.length > 0
      ) {
        const expectedInstallmentCount =
          repaymentFrequency === "MONTHLY"
            ? tenure
            : Math.ceil((tenure * 52) / 12);
        if (installmentSchedule.length !== expectedInstallmentCount)
          errors.push({
            code: "INSTALLMENT_SCHEDULE_COUNT_INVALID",
            message:
              "The installment schedule count must match the declared frequency and tenure.",
          });
        const maturity = addMonths(contract.startDate!, tenure);
        const lastDueDate = String(installmentSchedule.at(-1)!.dueDate);
        const canonicalDates = installmentSchedule.map((_, index) =>
          repaymentFrequency === "WEEKLY"
            ? addDays(contract.startDate!, (index + 1) * 7)
            : addMonths(contract.startDate!, index + 1),
        );
        const cadenceValid = installmentSchedule.every(
          (entry, index) => String(entry.dueDate) === canonicalDates[index],
        );
        if (!cadenceValid)
          errors.push({
            code: "INSTALLMENT_SCHEDULE_CADENCE_INVALID",
            message:
              "Installment due dates must follow the declared repayment cadence.",
          });
        if (
          lastDueDate < maturity ||
          (repaymentFrequency === "MONTHLY" && lastDueDate !== maturity)
        )
          errors.push({
            code: "INSTALLMENT_SCHEDULE_COVERAGE_INVALID",
            message:
              "The installment schedule must cover the declared contract maturity.",
          });
      }
    }
    if (
      Array.isArray(repaymentHistory) &&
      isIsoCalendarDate(contract.startDate) &&
      isIsoCalendarDate(contract.endDate) &&
      repaymentHistory.some(
        (entry) =>
          String(entry.date) < contract.startDate! ||
          String(entry.date) > contract.endDate!,
      )
    )
      errors.push({
        code: "REPAYMENT_DATE_OUT_OF_RANGE",
        message: "Repayment dates must fall within the contract dates.",
      });
    if (contractTotal > 0n && principal > contractTotal)
      errors.push({
        code: "PRINCIPAL_EXCEEDS_CONTRACT_TOTAL",
        message: "Principal cannot exceed the explicit contract total.",
      });
    if (contractTotal > 0n && openingBalance > contractTotal)
      errors.push({
        code: "OPENING_BALANCE_EXCEEDS_CONTRACT_TOTAL",
        message: "Opening balance cannot exceed the explicit contract total.",
      });
    if (Array.isArray(installmentSchedule)) {
      const scheduleTotal = installmentSchedule.reduce(
        (total, entry) => total + BigInt(String(entry.amountMinorUnits)),
        0n,
      );
      if (contractTotal > 0n && scheduleTotal !== contractTotal)
        errors.push({
          code: "INSTALLMENT_SCHEDULE_TOTAL_MISMATCH",
          message: "The installment schedule must equal the contract total.",
        });
      if (Array.isArray(repaymentHistory)) {
        const netPaid = repaymentHistory.reduce(
          (total, entry) =>
            total +
            BigInt(
              String(entry.signedAmountMinorUnits ?? entry.amountMinorUnits),
            ),
          0n,
        );
        if (netPaid !== totalPaid)
          errors.push({
            code: "REPAYMENT_TOTAL_MISMATCH",
            message:
              "Repayment history net does not equal the explicit paid total.",
          });
        if (contractTotal > 0n && netPaid > contractTotal)
          errors.push({
            code: "REPAYMENT_EXCEEDS_CONTRACT_TOTAL",
            message: "Net paid cannot exceed the contract total.",
          });
        if (contractTotal > 0n && amount !== contractTotal - netPaid)
          errors.push({
            code: "CURRENT_BALANCE_RECONCILIATION_MISMATCH",
            message:
              "Current balance does not reconcile to contract total and net paid.",
          });
        const schedulePaid = installmentSchedule.reduce(
          (total, entry) =>
            total + BigInt(String(entry.paidAmountMinorUnits ?? "0")),
          0n,
        );
        if (schedulePaid !== netPaid)
          errors.push({
            code: "INSTALLMENT_PAID_TOTAL_MISMATCH",
            message:
              "Installment paid amounts must equal repayment-history net paid.",
          });
      }
      if (!isIsoCalendarDate(arrearsAsOfDate))
        errors.push({
          code: "ARREARS_AS_OF_DATE_REQUIRED",
          message: "A valid arrears as-of date is required.",
        });
      else {
        const expectedArrears = installmentSchedule.reduce((total, entry) => {
          const status = String(entry.status);
          if (
            String(entry.dueDate) > arrearsAsOfDate! ||
            ["PAID", "WAIVED"].includes(status)
          )
            return total;
          const amountDue = BigInt(String(entry.amountMinorUnits));
          const paid = BigInt(String(entry.paidAmountMinorUnits ?? "0"));
          return total + amountDue - paid;
        }, 0n);
        if (arrears !== expectedArrears)
          errors.push({
            code: "ARREARS_RECONCILIATION_MISMATCH",
            message:
              "Arrears does not reconcile to overdue unpaid installments.",
          });
      }
    }
    let attachment: ValidatedRow["attachment"] = null;
    const attachmentDocumentId =
      payload.attachmentDocumentId ??
      stringField(payload, "attachmentDocumentId", "attachment_document_id");
    if (attachmentDocumentId === undefined)
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
         where id = ${attachmentDocumentId}
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
        fullName: customer.fullName ?? null,
        dateOfBirth: customer.dateOfBirth ?? null,
      },
      guarantor: {
        legacyId: guarantor.legacyId ?? null,
        fullName: guarantor.fullName ?? null,
        phoneE164: guarantorPhone,
        ghanaCardFingerprint: guarantorFingerprint,
        dateOfBirth: guarantor.dateOfBirth ?? null,
      },
      contract: {
        legacyId: contract.legacyId ?? null,
        reference: contractReference ?? null,
        startDate: contract.startDate ?? null,
        endDate: contract.endDate ?? null,
        totalMinorUnits:
          typeof contractTotalValue === "string" ? contractTotalValue : null,
        principalMinorUnits:
          typeof principalValue === "string" ? principalValue : null,
        openingBalanceMinorUnits:
          typeof openingBalanceValue === "string" ? openingBalanceValue : null,
      },
      vehicle: {
        legacyId: vehicle.legacyId ?? null,
        vin: vehicle.vin ?? null,
        chassisNumber: vehicle.chassisNumber ?? null,
        model: vehicle.model ?? null,
      },
      currentBalanceMinorUnits: amount.toString(),
      arrearsMinorUnits: arrears.toString(),
      arrearsAsOfDate: arrearsAsOfDate ?? null,
      totalPaidMinorUnits:
        typeof totalPaidValue === "string" ? totalPaidValue : null,
      repaymentFrequency,
      tenureMonths: tenure,
      repaymentHistory: Array.isArray(repaymentHistory) ? repaymentHistory : [],
      installmentSchedule: Array.isArray(installmentSchedule)
        ? installmentSchedule
        : [],
    };
    result.push({
      id: randomUUID(),
      sourceRecordId,
      sourceRowNumber: suppliedSourceRowNumber ?? 0,
      payload,
      normalized,
      payloadHash: payloadHash(payload),
      rowFingerprint: payloadHash(payload),
      amountMinorUnits: amount,
      legacyCustomerId: customer.legacyId ?? null,
      legacyGuarantorId: guarantor.legacyId ?? null,
      legacyContractId: contract.legacyId ?? null,
      legacyVehicleId: vehicle.legacyId ?? null,
      attachmentDocumentId: attachmentDocumentId ?? null,
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
  const normalizedContract = (normalized.contract ?? {}) as Record<
    string,
    unknown
  >;
  const normalizedVehicle = (normalized.vehicle ?? {}) as Record<
    string,
    unknown
  >;
  const contractReference =
    row.payload === undefined
      ? typeof normalizedContract.reference === "string"
        ? normalizedContract.reference
        : null
      : (contractFromPayload(row.payload).reference ??
        (typeof normalizedContract.reference === "string"
          ? normalizedContract.reference
          : null));
  const vehicle =
    row.payload === undefined
      ? normalizedVehicle
      : vehicleFromPayload(row.payload);
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

type LegacyPersonFields = {
  legacyId?: string | undefined;
  fullName?: string | undefined;
  phoneE164?: string | undefined;
  ghanaCard?: string | undefined;
  ghanaCardFingerprint?: string | undefined;
  dateOfBirth?: string | undefined;
};

function applicantFromPayload(payload: LegacyImportRow): LegacyPersonFields {
  const nested = payload.applicant ?? payload.customer ?? {};
  return {
    ...nested,
    legacyId:
      nested.legacyId ??
      stringField(payload, "applicantLegacyId", "applicant_legacy_id"),
    fullName:
      nested.fullName ??
      stringField(payload, "applicantFullName", "applicant_full_name"),
    phoneE164:
      nested.phoneE164 ??
      stringField(payload, "applicantPhoneE164", "applicant_phone_e164"),
    ghanaCardFingerprint:
      nested.ghanaCardFingerprint ??
      stringField(
        payload,
        "applicantGhanaCardFingerprint",
        "applicant_ghana_card_fingerprint",
      ),
    dateOfBirth:
      nested.dateOfBirth ??
      stringField(payload, "applicantDateOfBirth", "applicant_date_of_birth"),
  };
}

function guarantorFromPayload(payload: LegacyImportRow): LegacyPersonFields {
  const nested = payload.guarantor ?? {};
  return {
    ...nested,
    legacyId:
      nested.legacyId ??
      stringField(payload, "guarantorLegacyId", "guarantor_legacy_id"),
    fullName:
      nested.fullName ??
      stringField(payload, "guarantorFullName", "guarantor_full_name"),
    phoneE164:
      nested.phoneE164 ??
      stringField(payload, "guarantorPhoneE164", "guarantor_phone_e164"),
    ghanaCardFingerprint:
      nested.ghanaCardFingerprint ??
      stringField(
        payload,
        "guarantorGhanaCardFingerprint",
        "guarantor_ghana_card_fingerprint",
      ),
    ghanaCard:
      nested.ghanaCard ??
      stringField(payload, "guarantorGhanaCard", "guarantor_ghana_card"),
    dateOfBirth:
      nested.dateOfBirth ??
      stringField(payload, "guarantorDateOfBirth", "guarantor_date_of_birth"),
  };
}

function contractFromPayload(payload: LegacyImportRow): {
  legacyId?: string | undefined;
  reference?: string | undefined;
  startDate?: string | undefined;
  endDate?: string | undefined;
  totalMinorUnits?: string | undefined;
  principalMinorUnits?: string | undefined;
  openingBalanceMinorUnits?: string | undefined;
} {
  const nested = payload.contract ?? {};
  return {
    ...nested,
    legacyId:
      nested.legacyId ??
      stringField(payload, "contractLegacyId", "contract_legacy_id"),
    reference:
      nested.reference ??
      stringField(payload, "contractReference", "contract_reference"),
    startDate:
      nested.startDate ??
      stringField(payload, "contractStartDate", "contract_start_date"),
    endDate:
      nested.endDate ??
      stringField(payload, "contractEndDate", "contract_end_date"),
    totalMinorUnits:
      nested.totalMinorUnits ??
      stringField(
        payload,
        "contractTotalMinorUnits",
        "contract_total_minor_units",
      ),
    principalMinorUnits:
      nested.principalMinorUnits ??
      stringField(payload, "principalMinorUnits", "principal_minor_units"),
    openingBalanceMinorUnits:
      nested.openingBalanceMinorUnits ??
      stringField(
        payload,
        "openingBalanceMinorUnits",
        "opening_balance_minor_units",
      ),
  };
}

function vehicleFromPayload(payload: LegacyImportRow): {
  legacyId?: string | undefined;
  vin?: string | undefined;
  chassisNumber?: string | undefined;
  model?: string | undefined;
} {
  const nested = payload.vehicle ?? {};
  return {
    ...nested,
    legacyId:
      nested.legacyId ??
      stringField(payload, "vehicleLegacyId", "vehicle_legacy_id"),
    vin: nested.vin ?? stringField(payload, "vehicleVin", "vehicle_vin"),
    chassisNumber:
      nested.chassisNumber ??
      stringField(payload, "vehicleChassisNumber", "vehicle_chassis_number"),
    model:
      nested.model ??
      stringField(payload, "somocoVehicleModel", "somoco_vehicle_model"),
  };
}

function stringField(
  payload: LegacyImportRow,
  ...keys: readonly string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function numberField(
  payload: LegacyImportRow,
  ...keys: readonly string[]
): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && /^\d+$/.test(value.trim()))
      return Number(value);
  }
  return undefined;
}

function isIsoCalendarDate(value: string | undefined): boolean {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}

export function addMonths(value: string, months: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const targetMonthIndex = month! - 1 + months;
  const targetYear = year! + Math.floor(targetMonthIndex / 12);
  const targetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const leapYear =
    targetYear % 4 === 0 && (targetYear % 100 !== 0 || targetYear % 400 === 0);
  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][targetMonth]!;
  return [
    targetYear.toString().padStart(4, "0"),
    (targetMonth + 1).toString().padStart(2, "0"),
    Math.min(day!, daysInMonth).toString().padStart(2, "0"),
  ].join("-");
}

export function addDays(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const result = new Date(Date.UTC(year!, month! - 1, day! + days));
  return [
    result.getUTCFullYear().toString().padStart(4, "0"),
    (result.getUTCMonth() + 1).toString().padStart(2, "0"),
    result.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

function parseRepaymentHistory(
  value: unknown,
): readonly Record<string, unknown>[] | undefined {
  const parsed = parseJsonArray(value);
  if (parsed === undefined) return undefined;
  const result: Record<string, unknown>[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return undefined;
    const row = item as Record<string, unknown>;
    const date = row.date ?? row.paymentDate;
    const amount = row.amountMinorUnits ?? row.amount;
    const type = row.type;
    const reference = row.reference;
    const currency = row.currency;
    const reversesReference = row.reversesReference ?? row.reverses_reference;
    const providerReference = row.providerReference ?? row.provider_reference;
    const normalizedType = typeof type === "string" ? type.toUpperCase() : "";
    if (
      typeof date !== "string" ||
      !isIsoCalendarDate(date) ||
      typeof amount !== "string" ||
      !/^-?(0|[1-9][0-9]*)$/.test(amount) ||
      (amount.startsWith("-") &&
        !["REVERSAL", "REFUND"].includes(normalizedType)) ||
      typeof type !== "string" ||
      !/^[A-Z][A-Z0-9_]{1,31}$/.test(normalizedType) ||
      typeof reference !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(reference) ||
      (reversesReference !== undefined &&
        (typeof reversesReference !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(reversesReference))) ||
      (providerReference !== undefined &&
        (typeof providerReference !== "string" ||
          !/^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/.test(providerReference))) ||
      currency !== "GHS"
    )
      return undefined;
    const absoluteAmount = BigInt(
      amount.startsWith("-") ? amount.slice(1) : amount,
    );
    const signedAmount =
      amount.startsWith("-") ||
      normalizedType === "REVERSAL" ||
      normalizedType === "REFUND"
        ? -absoluteAmount
        : absoluteAmount;
    result.push({
      date,
      amountMinorUnits: amount,
      signedAmountMinorUnits: signedAmount.toString(),
      type: normalizedType,
      reference,
      ...(reversesReference === undefined ? {} : { reversesReference }),
      ...(providerReference === undefined ? {} : { providerReference }),
      currency,
    });
  }
  return result;
}

function repaymentHistoryValidationErrors(
  history: readonly Record<string, unknown>[],
): readonly string[] {
  const errors: string[] = [];
  const references = new Set<string>();
  const providerReferences = new Set<string>();
  const payments = new Map<string, { amount: bigint; date: string }>();
  const reversalTotals = new Map<string, bigint>();
  let previousDate: string | undefined;
  for (const entry of history) {
    const date = String(entry.date);
    const reference = String(entry.reference);
    const providerReference =
      typeof entry.providerReference === "string"
        ? entry.providerReference
        : undefined;
    const type = String(entry.type).toUpperCase();
    const rawAmount = String(entry.amountMinorUnits);
    const amount = BigInt(
      rawAmount.startsWith("-") ? rawAmount.slice(1) : rawAmount,
    );
    if (previousDate !== undefined && date < previousDate)
      errors.push("REPAYMENT_HISTORY_ORDER_INVALID");
    previousDate = date;
    if (references.has(reference)) errors.push("REPAYMENT_REFERENCE_DUPLICATE");
    references.add(reference);
    if (providerReference !== undefined) {
      if (providerReferences.has(providerReference))
        errors.push("REPAYMENT_PROVIDER_REFERENCE_DUPLICATE");
      providerReferences.add(providerReference);
    }
    if (type === "PAYMENT") {
      if (amount <= 0n) errors.push("PAYMENT_AMOUNT_INVALID");
      payments.set(reference, { amount, date });
      continue;
    }
    if (type !== "REVERSAL" && type !== "REFUND") continue;
    const reversesReference =
      typeof entry.reversesReference === "string"
        ? entry.reversesReference
        : undefined;
    if (reversesReference === undefined) {
      errors.push("REVERSAL_REFERENCE_REQUIRED");
      continue;
    }
    const payment = payments.get(reversesReference);
    if (payment === undefined || date < payment.date) {
      errors.push("REVERSAL_REFERENCE_INVALID");
      continue;
    }
    const reversedAmount =
      (reversalTotals.get(reversesReference) ?? 0n) + amount;
    reversalTotals.set(reversesReference, reversedAmount);
    if (reversedAmount > payment.amount)
      errors.push("REVERSAL_AMOUNT_EXCEEDS_PAYMENT");
  }
  return [...new Set(errors)];
}

function parseInstallmentSchedule(
  value: unknown,
): readonly Record<string, unknown>[] | undefined {
  const parsed = parseJsonArray(value);
  if (parsed === undefined) return undefined;
  const seen = new Set<number>();
  const result: Record<string, unknown>[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null || Array.isArray(item))
      return undefined;
    const row = item as Record<string, unknown>;
    const number = row.number ?? row.installmentNumber;
    const dueDate = row.dueDate;
    const amount = row.amountMinorUnits ?? row.amount;
    const status = row.status;
    const paidAmount = row.paidAmountMinorUnits ?? row.paidAmount ?? "0";
    if (
      typeof number !== "number" ||
      !Number.isSafeInteger(number) ||
      number < 1 ||
      seen.has(number) ||
      number !== result.length + 1 ||
      typeof dueDate !== "string" ||
      !isIsoCalendarDate(dueDate) ||
      (result.length > 0 && dueDate <= String(result.at(-1)?.dueDate)) ||
      typeof amount !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(amount) ||
      typeof status !== "string" ||
      ![
        "DUE",
        "PAID",
        "PARTIAL",
        "UNPAID",
        "MISSED",
        "WAIVED",
        "PENDING",
      ].includes(status) ||
      typeof paidAmount !== "string" ||
      !/^(0|[1-9][0-9]*)$/.test(paidAmount) ||
      BigInt(paidAmount) > BigInt(amount) ||
      row.currency !== "GHS"
    )
      return undefined;
    seen.add(number);
    result.push({
      number,
      dueDate,
      amountMinorUnits: amount,
      paidAmountMinorUnits: paidAmount,
      status,
      currency: "GHS",
    });
  }
  return result;
}

function parseJsonArray(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
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
  const events = await getInternalExecutor(db).execute<{
    id: string;
    event_key: string;
    event_type: string;
    reason_code: string | null;
    data: Record<string, unknown>;
    created_at: Date;
  }>(sql`
    select id, event_key, event_type, reason_code, data, created_at
      from migration_event
     where migration_batch_id = ${batchId}
     order by created_at asc, id asc
  `);
  const sampleEvidence = await getInternalExecutor(db).execute<{
    migration_record_id: string;
    verifier_staff_user_id: string;
    verified_at: Date;
    result: string;
  }>(sql`
    select migration_record_id, verifier_staff_user_id, verified_at, result
      from migration_sample_evidence
     where migration_batch_id = ${batchId}
     order by verified_at asc, id asc
  `);
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
    sampleEvidence: sampleEvidence.rows.map((evidence) => ({
      recordId: evidence.migration_record_id,
      verifierStaffUserId: evidence.verifier_staff_user_id,
      verifiedAt: new Date(evidence.verified_at).toISOString(),
      result: evidence.result,
    })),
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
    events: events.rows.map((event) => ({
      id: event.id,
      eventKey: event.event_key,
      eventType: event.event_type,
      reasonCode: event.reason_code,
      data: event.data,
      createdAt: new Date(event.created_at).toISOString(),
    })),
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
    approved_at: Date | null;
    expected_total_minor_units: bigint | string;
    reconciled_total_minor_units: bigint | string;
    sample_required: number;
    sample_passed: number;
    financial_evidence_hash: string | null;
    activated_at: Date | null;
  }>(
    sql`
      select b.id, b.source, b.source_batch_id,
             case when t.id is null then b.status else t.status end as status,
             b.expected_records,
             case when t.id is null then b.imported_records else t.imported_records end as imported_records,
             b.uploader_staff_user_id,
             case when t.id is null then b.verified_by else t.verified_by end as verified_by,
             case when t.id is null then b.verified_at else t.verified_at end as verified_at,
             case when t.id is null then b.approved_by else t.approved_by end as approved_by,
             case when t.id is null then b.expected_total_minor_units else t.expected_total_minor_units end as expected_total_minor_units,
             case when t.id is null then b.reconciled_total_minor_units else t.reconciled_total_minor_units end as reconciled_total_minor_units,
             case when t.id is null then b.sample_required else t.sample_required end as sample_required,
             case when t.id is null then b.sample_passed else t.sample_passed end as sample_passed,
             case when t.id is null then b.financial_evidence_hash else t.financial_evidence_hash end as financial_evidence_hash,
             case when t.id is null then b.activated_at else t.activated_at end as activated_at
        from migration_batch b
        left join lateral (
          select * from migration_batch_transition
           where migration_batch_id = b.id
           order by created_at desc, id desc
           limit 1
        ) t on true
       where b.id = ${batchId}
       for update of b
    `,
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

async function appendBatchTransition(
  db: Parameters<typeof getInternalExecutor>[0],
  input: {
    batchId: string;
    eventKey: string;
    eventType: string;
    actor: StaffPrincipal;
    requestId: string;
    reasonCode?: string;
    fields: Record<string, unknown>;
  },
) {
  const executor = getInternalExecutor(db);
  const current = await getBatch(db, input.batchId);
  if (current === null)
    throw new AppError(
      404,
      "MIGRATION_BATCH_NOT_FOUND",
      "Migration batch not found.",
    );
  const next = {
    status: String(input.fields.status ?? current.status),
    importedRecords: Number(
      input.fields.importedRecords ?? current.imported_records,
    ),
    expectedTotalMinorUnits: String(current.expected_total_minor_units),
    reconciledTotalMinorUnits: String(current.reconciled_total_minor_units),
    sampleRequired: Number(
      input.fields.sampleRequired ?? current.sample_required,
    ),
    samplePassed: Number(input.fields.samplePassed ?? current.sample_passed),
    verifiedBy: (input.fields.verifiedBy ?? current.verified_by) as
      string | null,
    verifiedAt: (input.fields.verifiedAt ?? current.verified_at) as Date | null,
    approvedBy: (input.fields.approvedBy ?? current.approved_by) as
      string | null,
    approvedAt: (input.fields.approvedAt ?? current.approved_at) as Date | null,
    financialEvidenceHash: (input.fields.financialEvidenceHash ??
      current.financial_evidence_hash) as string | null,
    activatedAt: (input.fields.activatedAt ??
      current.activated_at) as Date | null,
  };
  await executor.execute(
    sql`
      insert into migration_batch_transition
        (migration_batch_id, event_key, event_type, status, imported_records,
         expected_total_minor_units, reconciled_total_minor_units,
         sample_required, sample_passed, verified_by, verified_at, approved_by,
         approved_at, financial_evidence_hash, activated_at, actor_staff_user_id,
         request_id, reason_code, data, created_at)
      values
        (${input.batchId}, ${input.eventKey}, ${input.eventType}, ${next.status},
         ${next.importedRecords}, ${next.expectedTotalMinorUnits},
         ${next.reconciledTotalMinorUnits}, ${next.sampleRequired},
         ${next.samplePassed}, ${nullableSql(next.verifiedBy)}, ${nullableSql(next.verifiedAt)},
         ${nullableSql(next.approvedBy)}, ${nullableSql(next.approvedAt)}, ${nullableSql(next.financialEvidenceHash)},
         ${nullableSql(next.activatedAt)}, ${input.actor.staffUserId}, ${input.requestId},
         ${nullableSql(input.reasonCode)}, ${JSON.stringify(input.fields)}::jsonb, now())
      on conflict (event_key) do nothing
    `,
  );
}

function nullableSql(value: unknown) {
  return value === null || value === undefined ? sql`NULL` : sql`${value}`;
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

async function appendMigrationEvent(
  db: Parameters<typeof getInternalExecutor>[0],
  input: {
    batchId: string;
    recordId?: string;
    eventKey: string;
    eventType: string;
    actor: StaffPrincipal;
    requestId: string;
    reasonCode?: string;
    data: Record<string, unknown>;
  },
): Promise<void> {
  const executor = getInternalExecutor(db);
  await executor.execute(sql`
    insert into migration_event
      (migration_batch_id, migration_record_id, event_key, event_type,
       actor_staff_user_id, request_id, reason_code, data, created_at)
    values
      (${input.batchId}, ${input.recordId ?? null}, ${input.eventKey}, ${input.eventType},
       ${input.actor.staffUserId}, ${input.requestId}, ${input.reasonCode ?? null},
       ${JSON.stringify(input.data)}::jsonb, now())
    on conflict (event_key) do nothing
  `);
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

function parseRequiredAmount(value: unknown, code: string): bigint {
  if (typeof value !== "string") throw new Error(code);
  return parseAmount(value, code);
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
function batchFingerprint(input: {
  source: string;
  sourceBatchId: string;
  sourceFileHash: string;
  templateVersion: string;
  expectedRecords: number;
  sampleRequired: number;
  controlTotalMinorUnits: string | null;
  rows: readonly LegacyImportRow[];
}): string {
  return sha256(
    canonicalJson({
      source: input.source,
      sourceBatchId: input.sourceBatchId,
      sourceFileHash: input.sourceFileHash,
      templateVersion: input.templateVersion,
      expectedRecords: input.expectedRecords,
      sampleRequired: input.sampleRequired,
      controlTotalMinorUnits: input.controlTotalMinorUnits,
      rows: input.rows.map((row, index) => ({
        position: index,
        sourceRecordId: sourceRecordIdOf(row),
        sourceRowNumber:
          row.sourceRowNumber ?? numberField(row, "source_row_number") ?? null,
        rowFingerprint: payloadHash(row),
      })),
    }),
  );
}

function sourceRecordIdOf(payload: LegacyImportRow): string {
  return (
    (typeof payload.sourceRecordId === "string"
      ? payload.sourceRecordId
      : stringField(payload, "source_record_id")
    )?.trim() ?? ""
  );
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
