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
import { contract, installment } from "./contracts.js";

export const paymentStatus = pgEnum("payment_status", [
  "RECEIVED",
  "MATCHED",
  "POSTED",
  "REVERSED",
  "REFUNDED",
  "REJECTED",
]);

export const ledgerDirection = pgEnum("ledger_direction", ["DEBIT", "CREDIT"]);

export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "DEPOSIT",
  "REPAYMENT",
  "REVERSAL",
  "REFUND",
  "ADJUSTMENT",
]);

export const paymentTransaction = pgTable(
  "payment_transaction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerTransactionId: text("provider_transaction_id").notNull(),
    contractId: uuid("contract_id").references(() => contract.id, {
      onDelete: "restrict",
    }),
    payerReference: text("payer_reference").notNull(),
    currency: text("currency").notNull().default("GHS"),
    amountMinorUnits: bigint("amount_minor_units", {
      mode: "bigint",
    }).notNull(),
    status: paymentStatus("status").notNull().default("RECEIVED"),
    providerPayload: jsonb("provider_payload")
      .$type<Record<string, unknown>>()
      .notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payment_provider_transaction_unique").on(
      table.provider,
      table.providerTransactionId,
    ),
    index("payment_contract_idx").on(table.contractId),
    check("payment_currency_ghs", sql`${table.currency} = 'GHS'`),
    check("payment_amount_nonnegative", sql`${table.amountMinorUnits} >= 0`),
    check("payment_version_positive", sql`${table.version} > 0`),
  ],
);

export const ledgerEntry = pgTable(
  "ledger_entry",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    paymentTransactionId: uuid("payment_transaction_id").references(
      () => paymentTransaction.id,
      { onDelete: "restrict" },
    ),
    installmentId: uuid("installment_id").references(() => installment.id, {
      onDelete: "restrict",
    }),
    entryType: ledgerEntryType("entry_type").notNull(),
    direction: ledgerDirection("direction").notNull(),
    currency: text("currency").notNull().default("GHS"),
    amountMinorUnits: bigint("amount_minor_units", {
      mode: "bigint",
    }).notNull(),
    balanceAfterMinorUnits: bigint("balance_after_minor_units", {
      mode: "bigint",
    }).notNull(),
    reversesEntryId: uuid("reverses_entry_id"),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("ledger_contract_occurred_idx").on(
      table.contractId,
      table.occurredAt,
    ),
    check("ledger_currency_ghs", sql`${table.currency} = 'GHS'`),
    check("ledger_amount_positive", sql`${table.amountMinorUnits} > 0`),
    check(
      "ledger_balance_nonnegative",
      sql`${table.balanceAfterMinorUnits} >= 0`,
    ),
  ],
);

export const reconciliationCase = pgTable(
  "reconciliation_case",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentTransactionId: uuid("payment_transaction_id").references(
      () => paymentTransaction.id,
      { onDelete: "restrict" },
    ),
    status: text("status").notNull().default("OPEN"),
    reason: text("reason").notNull(),
    resolution: jsonb("resolution").$type<Record<string, unknown>>(),
    resolvedBy: uuid("resolved_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    check(
      "reconciliation_case_status_allowed",
      sql`${table.status} in ('OPEN', 'INVESTIGATING', 'RESOLVED')`,
    ),
    check("reconciliation_case_version_positive", sql`${table.version} > 0`),
  ],
);

export const arrearsSnapshot = pgTable(
  "arrears_snapshot",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    asOfDate: date("as_of_date").notNull(),
    overdueMinorUnits: bigint("overdue_minor_units", {
      mode: "bigint",
    }).notNull(),
    unpaidInstallments: integer("unpaid_installments").notNull(),
    consecutiveMissedInstallments: integer(
      "consecutive_missed_installments",
    ).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("arrears_contract_date_unique").on(
      table.contractId,
      table.asOfDate,
    ),
    check("arrears_overdue_nonnegative", sql`${table.overdueMinorUnits} >= 0`),
    check("arrears_unpaid_nonnegative", sql`${table.unpaidInstallments} >= 0`),
    check(
      "arrears_consecutive_nonnegative",
      sql`${table.consecutiveMissedInstallments} >= 0`,
    ),
  ],
);
