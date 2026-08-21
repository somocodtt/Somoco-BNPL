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
import { vehicleUnit } from "./assets.js";
import { offerVersion } from "./offers.js";

export const contractTemplateVersion = pgTable(
  "contract_template_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    templateKey: text("template_key").notNull(),
    versionNumber: integer("version_number").notNull(),
    contentHash: text("content_hash").notNull(),
    approvedPdfHash: text("approved_pdf_hash").notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    attestationMode: text("attestation_mode").notNull().default("PRODUCTION"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("contract_template_key_version_unique").on(
      table.templateKey,
      table.versionNumber,
    ),
    check(
      "contract_template_content_hash_sha256",
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "contract_template_pdf_hash_sha256",
      sql`${table.approvedPdfHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "contract_template_version_positive",
      sql`${table.versionNumber} > 0`,
    ),
    check(
      "contract_template_window_ordered",
      sql`${table.effectiveUntil} is null or ${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
    check(
      "contract_template_attestation_mode_allowed",
      sql`${table.attestationMode} in ('PRODUCTION', 'TEST')`,
    ),
  ],
);

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
    templateVersionId: uuid("template_version_id").references(
      () => contractTemplateVersion.id,
      { onDelete: "restrict" },
    ),
    vehicleUnitId: uuid("vehicle_unit_id")
      .notNull()
      .references(() => vehicleUnit.id, { onDelete: "restrict" }),
    status: contractStatus("status").notNull().default("DRAFT"),
    canonicalHash: text("canonical_hash"),
    previewReference: text("preview_reference"),
    ownershipHolder: text("ownership_holder").notNull().default("SOMOCO"),
    generatedAt: timestamp("generated_at", { withTimezone: true }),
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
    check(
      "contract_ownership_holder_somoco",
      sql`${table.ownershipHolder} = 'SOMOCO'`,
    ),
    check(
      "contract_canonical_hash_sha256",
      sql`${table.canonicalHash} is null or ${table.canonicalHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const contractExecution = pgTable(
  "contract_execution",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    contractId: uuid("contract_id")
      .notNull()
      .references(() => contract.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    applicantSignature: text("applicant_signature").notNull(),
    guarantorSignature: text("guarantor_signature").notNull(),
    staffWitnessId: uuid("staff_witness_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    executionDate: timestamp("execution_date", {
      withTimezone: true,
    }).notNull(),
    headOfficeLocation: text("head_office_location").notNull(),
    executedDocumentId: uuid("executed_document_id").notNull(),
    executedDocumentHash: text("executed_document_hash").notNull(),
    authorizationReason: text("authorization_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("contract_execution_contract_version_unique").on(
      table.contractId,
      table.versionNumber,
    ),
    check(
      "contract_execution_version_positive",
      sql`${table.versionNumber} > 0`,
    ),
    check(
      "contract_execution_document_hash_sha256",
      sql`${table.executedDocumentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "contract_execution_signatures_nonempty",
      sql`length(btrim(${table.applicantSignature})) > 0 and length(btrim(${table.guarantorSignature})) > 0`,
    ),
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
    uniqueIndex("repayment_schedule_id_contract_unique").on(
      table.id,
      table.contractId,
    ),
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
    contractId: uuid("contract_id").notNull(),
    repaymentScheduleId: uuid("repayment_schedule_id").notNull(),
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
    uniqueIndex("installment_id_contract_unique").on(
      table.id,
      table.contractId,
    ),
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
    check(
      "installment_paid_not_above_amount",
      sql`${table.paidMinorUnits} <= ${table.amountMinorUnits}`,
    ),
    check("installment_version_positive", sql`${table.version} > 0`),
    foreignKey({
      columns: [table.repaymentScheduleId, table.contractId],
      foreignColumns: [repaymentSchedule.id, repaymentSchedule.contractId],
      name: "installment_schedule_contract_fk",
    }).onDelete("restrict"),
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
    checklistVersion: text("checklist_version").notNull().default("v1"),
    customerAcknowledgedAt: timestamp("customer_acknowledged_at", {
      withTimezone: true,
    }),
    customerAcknowledgedByPersonId: uuid("customer_acknowledged_by_person_id"),
    condition: jsonb("condition")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    accessories: jsonb("accessories").$type<string[]>().notNull().default([]),
    headOfficeLocation: text("head_office_location")
      .notNull()
      .default("Somoco head office"),
    version: integer("version").notNull().default(1),
    handedOverBy: uuid("handed_over_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    handedOverAt: timestamp("handed_over_at", { withTimezone: true }).notNull(),
  },
  (table) => [uniqueIndex("handover_contract_unique").on(table.contractId)],
);

export const assetContractCommand = pgTable(
  "asset_contract_command",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(
      () => staffUser.id,
      { onDelete: "restrict" },
    ),
    actorPersonId: uuid("actor_person_id"),
    applicationId: uuid("application_id").references(() => application.id, {
      onDelete: "restrict",
    }),
    contractId: uuid("contract_id").references(() => contract.id, {
      onDelete: "restrict",
    }),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("asset_contract_command_scope_key_unique").on(
      table.scope,
      table.idempotencyKey,
    ),
    check(
      "asset_contract_command_payload_hash_sha256",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "asset_contract_command_actor_exclusive",
      sql`(${table.actorStaffUserId} is not null) <> (${table.actorPersonId} is not null)`,
    ),
    check(
      "asset_contract_command_type_allowed",
      sql`${table.commandType} in ('VEHICLE_REGISTER', 'VEHICLE_ASSIGN', 'CONTRACT_GENERATE', 'CONTRACT_EXECUTE', 'HANDOVER_COMPLETE', 'CONTRACT_ACTIVATE', 'TRACKER_ACCESS')`,
    ),
  ],
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
