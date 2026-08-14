import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
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

export const migrationBatch = pgTable(
  "migration_batch",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    source: text("source").notNull(),
    sourceBatchId: text("source_batch_id").notNull(),
    status: text("status").notNull().default("QUARANTINED"),
    expectedRecords: integer("expected_records").notNull(),
    importedRecords: integer("imported_records").notNull().default(0),
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
  await migrate(db, { migrationsFolder });
}
