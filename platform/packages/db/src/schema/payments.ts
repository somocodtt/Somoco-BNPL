import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  foreignKey,
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
import { contract, installment } from "./contracts.js";
import { offer } from "./offers.js";

export const paymentStatus = pgEnum("payment_status", [
  "RECEIVED",
  "MATCHED",
  "POSTED",
  "REVERSED",
  "REFUNDED",
  "REJECTED",
]);

export const paymentProvider = pgEnum("payment_provider", ["SOMOCO_PAYMENTS"]);

export const paymentChannel = pgEnum("payment_channel", [
  "USSD",
  "MOBILE_MONEY",
]);

export const ledgerDirection = pgEnum("ledger_direction", ["DEBIT", "CREDIT"]);

export const ledgerEntryType = pgEnum("ledger_entry_type", [
  "DEPOSIT",
  "REPAYMENT",
  "REVERSAL",
  "REFUND",
  "ADJUSTMENT",
]);

export const paymentAllocationPolicy = pgTable(
  "payment_allocation_policy",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    version: text("version").notNull(),
    policyHash: text("policy_hash").notNull(),
    workedExampleHash: text("worked_example_hash").notNull(),
    workedExample: jsonb("worked_example")
      .$type<Record<string, unknown>>()
      .notNull(),
    financeApprovedBy: text("finance_approved_by").notNull(),
    complianceApprovedBy: text("compliance_approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    status: text("status").notNull().default("APPROVED"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payment_allocation_policy_version_unique").on(table.version),
    check(
      "payment_allocation_policy_version_nonempty",
      sql`length(btrim(${table.version})) > 0`,
    ),
    check(
      "payment_allocation_policy_hash_sha256",
      sql`${table.policyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "payment_allocation_policy_worked_hash_sha256",
      sql`${table.workedExampleHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "payment_allocation_policy_approvers_distinct",
      sql`length(btrim(${table.financeApprovedBy})) > 0 and length(btrim(${table.complianceApprovedBy})) > 0 and ${table.financeApprovedBy} <> ${table.complianceApprovedBy}`,
    ),
    check(
      "payment_allocation_policy_status_allowed",
      sql`${table.status} in ('APPROVED', 'REVOKED')`,
    ),
  ],
);

export const depositReconciliation = pgTable(
  "deposit_reconciliation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id, { onDelete: "restrict" }),
    paymentTransactionId: uuid("payment_transaction_id").references(
      () => paymentTransaction.id,
      { onDelete: "restrict" },
    ),
    amountMinorUnits: bigint("amount_minor_units", {
      mode: "bigint",
    }).notNull(),
    currency: text("currency").notNull().default("GHS"),
    status: text("status").notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    reconciledBy: uuid("reconciled_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    evidenceHash: text("evidence_hash").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("deposit_reconciliation_application_offer_unique").on(
      table.applicationId,
      table.offerId,
    ),
    check(
      "deposit_reconciliation_amount_positive",
      sql`${table.amountMinorUnits} > 0`,
    ),
    check(
      "deposit_reconciliation_currency_ghs",
      sql`${table.currency} = 'GHS'`,
    ),
    check(
      "deposit_reconciliation_status_allowed",
      sql`${table.status} in ('PENDING', 'RECONCILED', 'REJECTED')`,
    ),
    check(
      "deposit_reconciliation_reconciled_evidence",
      sql`${table.status} <> 'RECONCILED' or (${table.reconciledAt} is not null and ${table.evidenceHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check("deposit_reconciliation_version_positive", sql`${table.version} > 0`),
  ],
);

export const paymentTransaction = pgTable(
  "payment_transaction",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: paymentProvider("provider").notNull(),
    channel: paymentChannel("channel").notNull(),
    providerTransactionId: text("provider_transaction_id").notNull(),
    eventId: text("event_id"),
    eventType: text("event_type"),
    settlementReference: text("settlement_reference"),
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
    uniqueIndex("payment_transaction_id_contract_unique").on(
      table.id,
      table.contractId,
    ),
    uniqueIndex("payment_provider_transaction_unique").on(
      table.provider,
      table.providerTransactionId,
    ),
    uniqueIndex("payment_provider_event_unique")
      .on(table.provider, table.eventId)
      .where(sql`${table.eventId} is not null`),
    index("payment_contract_idx").on(table.contractId),
    check("payment_currency_ghs", sql`${table.currency} = 'GHS'`),
    check("payment_amount_nonnegative", sql`${table.amountMinorUnits} >= 0`),
    check("payment_version_positive", sql`${table.version} > 0`),
    check(
      "payment_event_type_allowed",
      sql`${table.eventType} is null or ${table.eventType} in ('PAYMENT_SUCCEEDED', 'PAYMENT_REVERSED', 'PAYMENT_REFUNDED')`,
    ),
  ],
);

export const ledgerEntry = pgTable(
  "ledger_entry",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    postingKey: text("posting_key").notNull(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    paymentTransactionId: uuid("payment_transaction_id"),
    installmentId: uuid("installment_id"),
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
    allocationPolicyVersion: text("allocation_policy_version"),
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
    uniqueIndex("ledger_posting_key_unique").on(table.postingKey),
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
    check(
      "ledger_policy_version_nonempty",
      sql`${table.allocationPolicyVersion} is null or length(btrim(${table.allocationPolicyVersion})) > 0`,
    ),
    foreignKey({
      columns: [table.paymentTransactionId, table.contractId],
      foreignColumns: [paymentTransaction.id, paymentTransaction.contractId],
      name: "ledger_payment_contract_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.installmentId, table.contractId],
      foreignColumns: [installment.id, installment.contractId],
      name: "ledger_installment_contract_fk",
    }).onDelete("restrict"),
    foreignKey({
      columns: [table.reversesEntryId],
      foreignColumns: [table.id],
      name: "ledger_reverses_entry_fk",
    }).onDelete("restrict"),
    check(
      "ledger_reversal_link_consistent",
      sql`(${table.entryType} in ('REVERSAL', 'REFUND') and ${table.reversesEntryId} is not null) or (${table.entryType} not in ('REVERSAL', 'REFUND') and ${table.reversesEntryId} is null)`,
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
    dedupeKey: text("dedupe_key"),
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
    uniqueIndex("reconciliation_case_dedupe_key_unique")
      .on(table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
    check(
      "reconciliation_case_status_allowed",
      sql`${table.status} in ('OPEN', 'INVESTIGATING', 'RESOLVED')`,
    ),
    check("reconciliation_case_version_positive", sql`${table.version} > 0`),
  ],
);

export const paymentReceipt = pgTable(
  "payment_receipt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    paymentTransactionId: uuid("payment_transaction_id")
      .notNull()
      .references(() => paymentTransaction.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id").references(() => contract.id, {
      onDelete: "restrict",
    }),
    receiptNumber: text("receipt_number").notNull(),
    payerReference: text("payer_reference").notNull(),
    amountMinorUnits: bigint("amount_minor_units", {
      mode: "bigint",
    }).notNull(),
    currency: text("currency").notNull().default("GHS"),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    securePath: text("secure_path").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payment_receipt_transaction_unique").on(
      table.paymentTransactionId,
    ),
    uniqueIndex("payment_receipt_number_unique").on(table.receiptNumber),
    check(
      "payment_receipt_amount_positive",
      sql`${table.amountMinorUnits} > 0`,
    ),
    check("payment_receipt_currency_ghs", sql`${table.currency} = 'GHS'`),
  ],
);

export const paymentAdjustment = pgTable(
  "payment_adjustment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    makerStaffUserId: uuid("maker_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    checkerStaffUserId: uuid("checker_staff_user_id").references(
      () => staffUser.id,
      { onDelete: "restrict" },
    ),
    ledgerEntryId: uuid("ledger_entry_id").references(() => ledgerEntry.id, {
      onDelete: "restrict",
    }),
    amountMinorUnits: bigint("amount_minor_units", {
      mode: "bigint",
    }).notNull(),
    direction: ledgerDirection("direction").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("PENDING"),
    idempotencyKey: text("idempotency_key").notNull(),
    decisionAt: timestamp("decision_at", { withTimezone: true }),
    decisionReason: text("decision_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payment_adjustment_idempotency_unique").on(
      table.idempotencyKey,
    ),
    check(
      "payment_adjustment_amount_positive",
      sql`${table.amountMinorUnits} > 0`,
    ),
    check(
      "payment_adjustment_status_allowed",
      sql`${table.status} in ('PENDING', 'APPROVED', 'REJECTED')`,
    ),
    check(
      "payment_adjustment_checker_separate",
      sql`${table.checkerStaffUserId} is null or ${table.checkerStaffUserId} <> ${table.makerStaffUserId}`,
    ),
    check(
      "payment_adjustment_decision_consistent",
      sql`${table.status} = 'PENDING' or (${table.checkerStaffUserId} is not null and ${table.decisionAt} is not null)`,
    ),
  ],
);

export const paymentSettlementBatch = pgTable(
  "payment_settlement_batch",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: paymentProvider("provider").notNull(),
    settlementReference: text("settlement_reference").notNull(),
    settlementCurrency: text("settlement_currency").notNull().default("GHS"),
    providerTotalMinorUnits: bigint("provider_total_minor_units", {
      mode: "bigint",
    }).notNull(),
    ledgerTotalMinorUnits: bigint("ledger_total_minor_units", {
      mode: "bigint",
    }).notNull(),
    varianceMinorUnits: bigint("variance_minor_units", {
      mode: "bigint",
    }).notNull(),
    status: text("status").notNull(),
    reconciliationCaseId: uuid("reconciliation_case_id").references(
      () => reconciliationCase.id,
      { onDelete: "restrict" },
    ),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("payment_settlement_provider_reference_unique").on(
      table.provider,
      table.settlementReference,
    ),
    check(
      "payment_settlement_provider_total_nonnegative",
      sql`${table.providerTotalMinorUnits} >= 0`,
    ),
    check(
      "payment_settlement_ledger_total_nonnegative",
      sql`${table.ledgerTotalMinorUnits} >= 0`,
    ),
    check(
      "payment_settlement_currency_ghs",
      sql`${table.settlementCurrency} = 'GHS'`,
    ),
    check(
      "payment_settlement_status_allowed",
      sql`${table.status} in ('MATCHED', 'VARIANCE', 'PENDING')`,
    ),
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
