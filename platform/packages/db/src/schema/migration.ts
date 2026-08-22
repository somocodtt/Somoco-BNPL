import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  bigint,
  check,
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
      "migration_record_amount_nonnegative",
      sql`${table.amountMinorUnits} is null or ${table.amountMinorUnits} >= 0`,
    ),
    check(
      "migration_record_status_allowed",
      sql`${table.status} in ('QUARANTINED', 'VALID', 'INVALID', 'IMPORTED', 'REJECTED')`,
    ),
  ],
);

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

export async function migrateDatabase(db: Database): Promise<void> {
  await migrate(getInternalDatabase(db), { migrationsFolder });
}
