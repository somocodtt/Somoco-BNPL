import { sql } from "drizzle-orm";
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
import { staffUser } from "./access.js";

export const reportExport = pgTable(
  "report_export",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requesterStaffUserId: uuid("requester_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    requestId: uuid("request_id").notNull(),
    reportType: text("report_type").notNull(),
    format: text("format").notNull(),
    dataClassification: text("data_classification").notNull(),
    filters: jsonb("filters").$type<Record<string, unknown>>().notNull(),
    rowCount: integer("row_count").notNull(),
    contentHash: text("content_hash").notNull(),
    artifact: jsonb("artifact").$type<Record<string, unknown>>().notNull(),
    status: text("status").notNull().default("READY"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("report_export_requester_idx").on(
      table.requesterStaffUserId,
      table.createdAt,
    ),
    index("report_export_request_idx").on(table.requestId),
    check(
      "report_export_type_allowed",
      sql`${table.reportType} in ('OPERATIONS', 'PORTFOLIO', 'AUDIT', 'MIGRATION')`,
    ),
    check(
      "report_export_format_allowed",
      sql`${table.format} in ('CSV', 'JSON')`,
    ),
    check(
      "report_export_classification_allowed",
      sql`${table.dataClassification} in ('REDACTED', 'PERSONAL_DATA')`,
    ),
    check(
      "report_export_status_allowed",
      sql`${table.status} in ('QUEUED', 'READY', 'FAILED')`,
    ),
    check("report_export_row_count_nonnegative", sql`${table.rowCount} >= 0`),
    check(
      "report_export_content_hash_sha256",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const reportExportEvent = pgTable(
  "report_export_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reportExportId: uuid("report_export_id")
      .notNull()
      .references(() => reportExport.id, { onDelete: "restrict" }),
    eventKey: text("event_key").notNull(),
    eventType: text("event_type").notNull(),
    contentHash: text("content_hash"),
    artifact: jsonb("artifact").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("report_export_event_key_unique").on(table.eventKey),
    index("report_export_event_export_created_idx").on(
      table.reportExportId,
      table.createdAt,
    ),
    check(
      "report_export_event_type_allowed",
      sql`${table.eventType} in ('QUEUED', 'READY', 'FAILED')`,
    ),
    check(
      "report_export_event_content_hash_sha256",
      sql`${table.contentHash} is null or ${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export type ReportExport = typeof reportExport.$inferSelect;
export type ReportExportEvent = typeof reportExportEvent.$inferSelect;
