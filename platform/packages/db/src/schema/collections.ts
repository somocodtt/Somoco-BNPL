import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
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
import { contract, recoveryCase } from "./contracts.js";
import { document } from "./privacy.js";

export const arrearsEscalation = pgTable(
  "arrears_escalation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    asOfDate: date("as_of_date").notNull(),
    signal: text("signal").notNull(),
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
    uniqueIndex("arrears_escalation_contract_date_signal_unique").on(
      table.contractId,
      table.asOfDate,
      table.signal,
    ),
    index("arrears_escalation_contract_idx").on(table.contractId),
    check(
      "arrears_escalation_signal_allowed",
      sql`${table.signal} in ('THREE_CONSECUTIVE_MISSED', 'THREE_TOTAL_UNPAID')`,
    ),
    check(
      "arrears_escalation_overdue_nonnegative",
      sql`${table.overdueMinorUnits} >= 0`,
    ),
    check(
      "arrears_escalation_counts_nonnegative",
      sql`${table.unpaidInstallments} >= 0 and ${table.consecutiveMissedInstallments} >= 0`,
    ),
  ],
);

export const recoveryDecision = pgTable(
  "recovery_decision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recoveryCaseId: uuid("recovery_case_id")
      .notNull()
      .references(() => recoveryCase.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key").notNull(),
    makerStaffUserId: uuid("maker_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    checkerStaffUserId: uuid("checker_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    decision: text("decision").notNull(),
    purpose: text("purpose").notNull(),
    reason: text("reason").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("recovery_decision_idempotency_unique").on(
      table.idempotencyKey,
    ),
    uniqueIndex("recovery_decision_case_unique").on(table.recoveryCaseId),
    index("recovery_decision_case_idx").on(table.recoveryCaseId),
    check(
      "recovery_decision_allowed",
      sql`${table.decision} in ('APPROVED', 'DENIED')`,
    ),
    check(
      "recovery_decision_maker_checker_distinct",
      sql`${table.makerStaffUserId} <> ${table.checkerStaffUserId}`,
    ),
    check(
      "recovery_decision_text_nonempty",
      sql`length(btrim(${table.purpose})) > 0 and length(btrim(${table.reason})) > 0`,
    ),
  ],
);

export const recoveryAction = pgTable(
  "recovery_action",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recoveryCaseId: uuid("recovery_case_id")
      .notNull()
      .references(() => recoveryCase.id, { onDelete: "restrict" }),
    idempotencyKey: text("idempotency_key"),
    payloadHash: text("payload_hash"),
    actionType: text("action_type").notNull(),
    purpose: text("purpose").notNull(),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    authorizedBy: uuid("authorized_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    evidenceHash: text("evidence_hash").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("recovery_action_case_idx").on(table.recoveryCaseId),
    uniqueIndex("recovery_action_idempotency_unique")
      .on(table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    check(
      "recovery_action_type_allowed",
      sql`${table.actionType} in ('MANUAL_RECOVERY', 'SEIZURE_EVIDENCE', 'VISIT', 'PROMISE_TO_PAY')`,
    ),
    check(
      "recovery_action_maker_checker_distinct",
      sql`${table.requestedBy} <> ${table.authorizedBy}`,
    ),
    check(
      "recovery_action_purpose_nonempty",
      sql`length(btrim(${table.purpose})) > 0`,
    ),
    check(
      "recovery_action_evidence_hash_sha256",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "recovery_action_payload_hash_sha256",
      sql`${table.payloadHash} is null or ${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const recoveryLocationLookup = pgTable(
  "recovery_location_lookup",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    recoveryCaseId: uuid("recovery_case_id")
      .notNull()
      .references(() => recoveryCase.id, { onDelete: "restrict" }),
    actorStaffUserId: uuid("actor_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    trackerId: text("tracker_id").notNull(),
    purpose: text("purpose").notNull(),
    latitude: text("latitude"),
    longitude: text("longitude"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    deviceStatus: text("device_status"),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("recovery_location_lookup_case_idx").on(table.recoveryCaseId),
    check(
      "recovery_location_lookup_purpose_nonempty",
      sql`length(btrim(${table.purpose})) > 0`,
    ),
    check(
      "recovery_location_lookup_status_allowed",
      sql`${table.deviceStatus} is null or ${table.deviceStatus} in ('ONLINE', 'OFFLINE', 'UNKNOWN')`,
    ),
  ],
);

export const settlementApproval = pgTable(
  "settlement_approval",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    approvalType: text("approval_type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("settlement_approval_idempotency_unique").on(
      table.idempotencyKey,
    ),
    uniqueIndex("settlement_approval_contract_type_unique").on(
      table.contractId,
      table.approvalType,
    ),
    check(
      "settlement_approval_type_allowed",
      sql`${table.approvalType} in ('FINANCE_RECONCILIATION', 'BUSINESS_OWNERSHIP_TRANSFER')`,
    ),
    check(
      "settlement_approval_reason_nonempty",
      sql`length(btrim(${table.reason})) > 0`,
    ),
  ],
);

export const settlementEvidence = pgTable(
  "settlement_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    evidenceDocumentId: uuid("evidence_document_id").references(
      () => document.id,
      { onDelete: "restrict" },
    ),
    evidenceDocumentReference: text("evidence_document_reference").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    evidenceObjectKey: text("evidence_object_key"),
    evidenceObjectVersionId: text("evidence_object_version_id"),
    evidenceObjectEtag: text("evidence_object_etag"),
    verificationStatus: text("verification_status").notNull(),
    acceptedBy: uuid("accepted_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("settlement_evidence_contract_unique").on(table.contractId),
    check(
      "settlement_evidence_status_allowed",
      sql`${table.verificationStatus} = 'CLEAN'`,
    ),
    check(
      "settlement_evidence_document_nonempty",
      sql`length(btrim(${table.evidenceDocumentReference})) > 0`,
    ),
    check(
      "settlement_evidence_hash_sha256",
      sql`${table.evidenceHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const settlementWorkflow = pgTable(
  "settlement_workflow",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("PENDING"),
    financeApprovalId: uuid("finance_approval_id").references(
      () => settlementApproval.id,
      { onDelete: "restrict" },
    ),
    businessApprovalId: uuid("business_approval_id").references(
      () => settlementApproval.id,
      { onDelete: "restrict" },
    ),
    evidenceId: uuid("evidence_id").references(() => settlementEvidence.id, {
      onDelete: "restrict",
    }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
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
    uniqueIndex("settlement_workflow_contract_unique").on(table.contractId),
    check(
      "settlement_workflow_status_allowed",
      sql`${table.status} in ('PENDING', 'SETTLED', 'TRANSFERRED', 'REJECTED')`,
    ),
    check("settlement_workflow_version_positive", sql`${table.version} > 0`),
  ],
);
