import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { staffUser } from "./access.js";
import { application } from "./applications.js";
import { vehicleUnit } from "./assets.js";
import { offerVersion } from "./offers.js";

export const contractStatus = pgEnum("contract_status", [
  "DRAFT",
  "AWAITING_EXECUTION",
  "EXECUTED",
  "ACTIVE",
  "SETTLED",
  "RECOVERY",
  "TERMINATED",
]);

export const installmentStatus = pgEnum("installment_status", [
  "PENDING",
  "PARTIALLY_PAID",
  "PAID",
  "OVERDUE",
  "WAIVED",
]);

export const contract = pgTable(
  "contract",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    reference: text("reference").notNull(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    offerVersionId: uuid("offer_version_id")
      .notNull()
      .references(() => offerVersion.id, { onDelete: "restrict" }),
    vehicleUnitId: uuid("vehicle_unit_id")
      .notNull()
      .references(() => vehicleUnit.id, { onDelete: "restrict" }),
    status: contractStatus("status").notNull().default("DRAFT"),
    outstandingBalanceMinorUnits: bigint("outstanding_balance_minor_units", {
      mode: "bigint",
    }).notNull(),
    version: integer("version").notNull().default(1),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("contract_reference_unique").on(table.reference),
    uniqueIndex("contract_application_unique").on(table.applicationId),
    check(
      "contract_balance_nonnegative",
      sql`${table.outstandingBalanceMinorUnits} >= 0`,
    ),
    check("contract_version_positive", sql`${table.version} > 0`),
  ],
);

export const repaymentSchedule = pgTable(
  "repayment_schedule",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    totalMinorUnits: bigint("total_minor_units", { mode: "bigint" }).notNull(),
    firstDueDate: date("first_due_date").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("repayment_schedule_contract_version_unique").on(
      table.contractId,
      table.versionNumber,
    ),
    check(
      "repayment_schedule_total_nonnegative",
      sql`${table.totalMinorUnits} >= 0`,
    ),
    check(
      "repayment_schedule_version_positive",
      sql`${table.versionNumber} > 0`,
    ),
  ],
);

export const installment = pgTable(
  "installment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    repaymentScheduleId: uuid("repayment_schedule_id")
      .notNull()
      .references(() => repaymentSchedule.id, { onDelete: "restrict" }),
    installmentNumber: integer("installment_number").notNull(),
    dueDate: date("due_date").notNull(),
    amountMinorUnits: bigint("amount_minor_units", {
      mode: "bigint",
    }).notNull(),
    paidMinorUnits: bigint("paid_minor_units", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
    status: installmentStatus("status").notNull().default("PENDING"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    uniqueIndex("installment_schedule_number_unique").on(
      table.repaymentScheduleId,
      table.installmentNumber,
    ),
    index("installment_due_date_idx").on(table.dueDate),
    check("installment_number_positive", sql`${table.installmentNumber} > 0`),
    check(
      "installment_amount_nonnegative",
      sql`${table.amountMinorUnits} >= 0`,
    ),
    check("installment_paid_nonnegative", sql`${table.paidMinorUnits} >= 0`),
    check("installment_version_positive", sql`${table.version} > 0`),
  ],
);

export const handoverRecord = pgTable(
  "handover_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    checklist: jsonb("checklist").$type<Record<string, unknown>>().notNull(),
    handedOverBy: uuid("handed_over_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("handover_contract_unique").on(table.contractId)],
);

export const ownershipTransfer = pgTable(
  "ownership_transfer",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("PENDING"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>(),
    approvedBy: uuid("approved_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    transferredAt: timestamp("transferred_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("ownership_transfer_contract_unique").on(table.contractId),
    check(
      "ownership_transfer_status_allowed",
      sql`${table.status} in ('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED')`,
    ),
    check("ownership_transfer_version_positive", sql`${table.version} > 0`),
  ],
);

export const recoveryCase = pgTable(
  "recovery_case",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    assignedOfficerId: uuid("assigned_officer_id").references(
      () => staffUser.id,
      {
        onDelete: "restrict",
      },
    ),
    status: text("status").notNull().default("OPEN"),
    details: jsonb("details")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    version: integer("version").notNull().default(1),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("recovery_case_contract_idx").on(table.contractId),
    check(
      "recovery_case_status_allowed",
      sql`${table.status} in ('OPEN', 'IN_PROGRESS', 'CLOSED')`,
    ),
    check("recovery_case_version_positive", sql`${table.version} > 0`),
  ],
);
