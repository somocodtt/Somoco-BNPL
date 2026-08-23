import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { Database } from "../client.js";
import { getInternalDatabase } from "../client.js";
import { staffUser } from "./access.js";
import { document } from "./privacy.js";

export const migrationBatch = pgTable(
  "migration_batch",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    sourceBatchId: text("source_batch_id").notNull(),
    sourceFileHash: text("source_file_hash"),
    templateVersion: text("template_version").notNull().default("legacy-v1"),
    batchFingerprint: text("batch_fingerprint"),
    schemaVersion: text("schema_version").notNull().default("legacy-v1"),
    sourceFileName: text("source_file_name"),
    uploaderStaffUserId: uuid("uploader_staff_user_id").references(
      () => staffUser.id,
      { onDelete: "restrict" },
    ),
    status: text("status").notNull().default("QUARANTINED"),
    expectedRecords: integer("expected_records").notNull(),
    importedRecords: integer("imported_records").notNull().default(0),
    expectedTotalMinorUnits: bigint("expected_total_minor_units", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`0`),
    reconciledTotalMinorUnits: bigint("reconciled_total_minor_units", {
      mode: "bigint",
    })
      .notNull()
      .default(sql`0`),
    controlTotalHash: text("control_total_hash"),
    sampleRequired: integer("sample_required").notNull().default(0),
    samplePassed: integer("sample_passed").notNull().default(0),
    verifiedBy: uuid("verified_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    financialEvidenceHash: text("financial_evidence_hash"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("migration_source_batch_unique").on(
      table.source,
      table.sourceBatchId,
    ),
    check(
      "migration_batch_status_allowed",
      sql`${table.status} in ('QUARANTINED', 'VALIDATED', 'APPROVED', 'IMPORTED', 'REJECTED')`,
    ),
    check("migration_expected_nonnegative", sql`${table.expectedRecords} >= 0`),
    check("migration_imported_nonnegative", sql`${table.importedRecords} >= 0`),
    check(
      "migration_source_file_hash_sha256",
      sql`${table.sourceFileHash} is null or ${table.sourceFileHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "migration_control_total_hash_sha256",
      sql`${table.controlTotalHash} is null or ${table.controlTotalHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "migration_financial_evidence_hash_sha256",
      sql`${table.financialEvidenceHash} is null or ${table.financialEvidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "migration_totals_nonnegative",
      sql`${table.expectedTotalMinorUnits} >= 0 and ${table.reconciledTotalMinorUnits} >= 0`,
    ),
    check(
      "migration_sample_counts_nonnegative",
      sql`${table.sampleRequired} >= 0 and ${table.samplePassed} >= 0 and ${table.samplePassed} <= ${table.sampleRequired}`,
    ),
    check("migration_batch_version_positive", sql`${table.version} > 0`),
  ],
);

export const migrationBatchTransition = pgTable(
  "migration_batch_transition",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    migrationBatchId: uuid("migration_batch_id")
      .notNull()
      .references(() => migrationBatch.id, { onDelete: "restrict" }),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    status: text("status").notNull(),
    importedRecords: integer("imported_records").notNull().default(0),
    expectedTotalMinorUnits: bigint("expected_total_minor_units", {
      mode: "bigint",
    }).notNull(),
    reconciledTotalMinorUnits: bigint("reconciled_total_minor_units", {
      mode: "bigint",
    }).notNull(),
    sampleRequired: integer("sample_required").notNull(),
    samplePassed: integer("sample_passed").notNull(),
    verifiedBy: uuid("verified_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    approvedBy: uuid("approved_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    financialEvidenceHash: text("financial_evidence_hash"),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    actorStaffUserId: uuid("actor_staff_user_id").references(
      () => staffUser.id,
      {
        onDelete: "restrict",
      },
    ),
    requestId: uuid("request_id"),
    reasonCode: text("reason_code"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("migration_batch_transition_key_unique").on(table.eventKey),
    index("migration_batch_transition_batch_created_idx").on(
      table.migrationBatchId,
      table.createdAt,
    ),
    check(
      "migration_batch_transition_event_type_allowed",
      sql`${table.eventType} in ('IMPORTED', 'VALIDATED', 'SAMPLED', 'APPROVED', 'ACTIVATED', 'QUARANTINED', 'REJECTED', 'CORRECTED')`,
    ),
    check(
      "migration_batch_transition_status_allowed",
      sql`${table.status} in ('QUARANTINED', 'VALIDATED', 'APPROVED', 'IMPORTED', 'REJECTED')`,
    ),
    check(
      "migration_batch_transition_totals_nonnegative",
      sql`${table.expectedTotalMinorUnits} >= 0 and ${table.reconciledTotalMinorUnits} >= 0`,
    ),
    check(
      "migration_batch_transition_sample_counts_nonnegative",
      sql`${table.sampleRequired} >= 0 and ${table.samplePassed} >= 0 and ${table.samplePassed} <= ${table.sampleRequired}`,
    ),
    check(
      "migration_batch_transition_financial_hash_sha256",
      sql`${table.financialEvidenceHash} is null or ${table.financialEvidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const migrationSampleEvidence = pgTable(
  "migration_sample_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    migrationBatchId: uuid("migration_batch_id")
      .notNull()
      .references(() => migrationBatch.id, { onDelete: "restrict" }),
    migrationRecordId: uuid("migration_record_id").notNull(),
    verifierStaffUserId: uuid("verifier_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    verifiedAt: timestamp("verified_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    result: text("result").notNull(),
    verificationCommandId: uuid("verification_command_id"),
    evidenceHash: text("evidence_hash"),
  },
  (table) => [
    uniqueIndex("migration_sample_evidence_row_unique").on(
      table.migrationBatchId,
      table.migrationRecordId,
    ),
    foreignKey({
      columns: [table.migrationBatchId, table.migrationRecordId],
      foreignColumns: [migrationRecord.migrationBatchId, migrationRecord.id],
      name: "migration_sample_evidence_batch_record_fk",
    }).onDelete("restrict"),
    index("migration_sample_evidence_batch_idx").on(
      table.migrationBatchId,
      table.verifiedAt,
    ),
    check(
      "migration_sample_evidence_result_allowed",
      sql`${table.result} in ('PASS', 'FAIL')`,
    ),
    check(
      "migration_sample_evidence_hash_sha256",
      sql`${table.evidenceHash} is null or ${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const migrationSampleEvidenceQuarantine = pgTable(
  "migration_sample_evidence_quarantine",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    originalEvidenceId: uuid("original_evidence_id").notNull(),
    migrationBatchId: uuid("migration_batch_id").notNull(),
    migrationRecordId: uuid("migration_record_id").notNull(),
    verifierStaffUserId: uuid("verifier_staff_user_id").notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }).notNull(),
    result: text("result").notNull(),
    verificationCommandId: uuid("verification_command_id"),
    evidenceHash: text("evidence_hash"),
    reasonCode: text("reason_code").notNull(),
    reasonData: jsonb("reason_data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    quarantinedAt: timestamp("quarantined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("migration_sample_evidence_quarantine_original_unique").on(
      table.originalEvidenceId,
    ),
    check(
      "migration_sample_evidence_quarantine_result_allowed",
      sql`${table.result} in ('PASS', 'FAIL')`,
    ),
    check(
      "migration_sample_evidence_quarantine_hash_sha256",
      sql`${table.evidenceHash} is null or ${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "migration_sample_evidence_quarantine_reason_code_safe",
      sql`${table.reasonCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
  ],
);

export const migrationRecord = pgTable(
  "migration_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    migrationBatchId: uuid("migration_batch_id")
      .notNull()
      .references(() => migrationBatch.id, { onDelete: "restrict" }),
    sourceRecordId: text("source_record_id").notNull(),
    status: text("status").notNull().default("QUARANTINED"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    normalizedRow: jsonb("normalized_row").$type<Record<string, unknown>>(),
    sourceRowNumber: integer("source_row_number"),
    sourceFileHash: text("source_file_hash"),
    templateVersion: text("template_version").notNull().default("legacy-v1"),
    payloadHash: text("payload_hash"),
    rowFingerprint: text("row_fingerprint"),
    amountMinorUnits: bigint("amount_minor_units", { mode: "bigint" }),
    legacyCustomerId: text("legacy_customer_id"),
    legacyGuarantorId: text("legacy_guarantor_id"),
    legacyContractId: text("legacy_contract_id"),
    legacyVehicleId: text("legacy_vehicle_id"),
    attachmentDocumentId: uuid("attachment_document_id").references(
      () => document.id,
      { onDelete: "restrict" },
    ),
    attachmentObjectKey: text("attachment_object_key"),
    attachmentObjectVersionId: text("attachment_object_version_id"),
    attachmentObjectEtag: text("attachment_object_etag"),
    matchCandidates: jsonb("match_candidates")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    validationOutcomes: jsonb("validation_outcomes")
      .$type<unknown[]>()
      .notNull()
      .default([]),
    verifiedBy: uuid("verified_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    approvedBy: uuid("approved_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    errors: jsonb("errors").$type<unknown[]>(),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("migration_record_source_unique").on(
      table.migrationBatchId,
      table.sourceRecordId,
    ),
    uniqueIndex("migration_record_batch_id_id_unique").on(
      table.migrationBatchId,
      table.id,
    ),
    index("migration_record_status_idx").on(table.status),
    index("migration_record_source_hash_idx").on(
      table.sourceFileHash,
      table.templateVersion,
    ),
    check(
      "migration_record_source_hash_sha256",
      sql`${table.sourceFileHash} is null or ${table.sourceFileHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "migration_record_payload_hash_sha256",
      sql`${table.payloadHash} is null or ${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "migration_record_row_fingerprint_sha256",
      sql`${table.rowFingerprint} is null or ${table.rowFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "migration_record_amount_nonnegative",
      sql`${table.amountMinorUnits} is null or ${table.amountMinorUnits} >= 0`,
    ),
    check(
      "migration_record_status_allowed",
      sql`${table.status} in ('QUARANTINED', 'VALID', 'INVALID', 'IMPORTED', 'REJECTED')`,
    ),
  ],
);

export const migrationEvent = pgTable(
  "migration_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    migrationBatchId: uuid("migration_batch_id")
      .notNull()
      .references(() => migrationBatch.id, { onDelete: "restrict" }),
    migrationRecordId: uuid("migration_record_id").references(
      () => migrationRecord.id,
      { onDelete: "restrict" },
    ),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(
      () => staffUser.id,
      { onDelete: "restrict" },
    ),
    requestId: uuid("request_id"),
    reasonCode: text("reason_code"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("migration_event_key_unique").on(table.eventKey),
    index("migration_event_batch_created_idx").on(
      table.migrationBatchId,
      table.createdAt,
    ),
    check(
      "migration_event_type_allowed",
      sql`${table.eventType} in ('IMPORTED', 'VALIDATED', 'SAMPLED', 'APPROVED', 'ACTIVATED', 'QUARANTINED', 'CORRECTED')`,
    ),
  ],
);

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export async function migrateDatabase(db: Database): Promise<void> {
  await migrate(getInternalDatabase(db), { migrationsFolder });
}
