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
import { vehicleModel } from "./products.js";

export const vehicleStatus = pgEnum("vehicle_status", [
  "IN_STOCK",
  "RESERVED",
  "ASSIGNED",
  "HANDED_OVER",
  "RECOVERED",
  "TRANSFERRED",
]);

export const registrationOwner = pgEnum("registration_owner", [
  "SOMOCO",
  "CUSTOMER",
]);

export const vehicleUnit = pgTable(
  "vehicle_unit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vehicleModelId: uuid("vehicle_model_id")
      .notNull()
      .references(() => vehicleModel.id, { onDelete: "restrict" }),
    vin: text("vin").notNull(),
    chassisNumber: text("chassis_number").notNull(),
    engineMotorIdentifier: text("engine_motor_identifier"),
    condition: jsonb("condition")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    accessories: jsonb("accessories").$type<string[]>().notNull().default([]),
    trackerIdentifier: text("tracker_identifier"),
    registrationNumber: text("registration_number"),
    status: vehicleStatus("status").notNull().default("IN_STOCK"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("vehicle_unit_vin_unique").on(table.vin),
    uniqueIndex("vehicle_unit_chassis_unique").on(table.chassisNumber),
    check("vehicle_unit_version_positive", sql`${table.version} > 0`),
    check("vehicle_unit_vin_nonempty", sql`length(btrim(${table.vin})) > 0`),
    check(
      "vehicle_unit_chassis_nonempty",
      sql`length(btrim(${table.chassisNumber})) > 0`,
    ),
    check(
      "vehicle_unit_engine_identifier_present",
      sql`${table.engineMotorIdentifier} is null or length(btrim(${table.engineMotorIdentifier})) > 0`,
    ),
  ],
);

export const vehicleAssignment = pgTable(
  "vehicle_assignment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    vehicleUnitId: uuid("vehicle_unit_id")
      .notNull()
      .references(() => vehicleUnit.id, { onDelete: "restrict" }),
    offerId: uuid("offer_id"),
    offerVersionId: uuid("offer_version_id"),
    depositReconciledAmountMinorUnits: bigint(
      "deposit_reconciled_amount_minor_units",
      { mode: "bigint" },
    ),
    depositEvidenceId: uuid("deposit_evidence_id"),
    supersedesAssignmentId: uuid("supersedes_assignment_id"),
    reassignmentApprovedBy: uuid("reassignment_approved_by").references(
      () => staffUser.id,
      { onDelete: "restrict" },
    ),
    reassignmentReason: text("reassignment_reason"),
    version: integer("version").notNull().default(1),
    assignedBy: uuid("assigned_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [
    index("vehicle_assignment_application_idx").on(table.applicationId),
    uniqueIndex("vehicle_assignment_active_vehicle_unique")
      .on(table.vehicleUnitId)
      .where(sql`${table.releasedAt} is null`),
    uniqueIndex("vehicle_assignment_active_application_unique")
      .on(table.applicationId)
      .where(sql`${table.releasedAt} is null`),
    check("vehicle_assignment_version_positive", sql`${table.version} > 0`),
    check(
      "vehicle_assignment_reassignment_consistent",
      sql`(${table.supersedesAssignmentId} is null and ${table.reassignmentApprovedBy} is null and ${table.reassignmentReason} is null) or (${table.supersedesAssignmentId} is not null and ${table.reassignmentApprovedBy} is not null and length(btrim(${table.reassignmentReason})) > 0)`,
    ),
  ],
);

export const vehicleReassignmentApproval = pgTable(
  "vehicle_reassignment_approval",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    previousAssignmentId: uuid("previous_assignment_id")
      .notNull()
      .references(() => vehicleAssignment.id, { onDelete: "restrict" }),
    requestedVehicleUnitId: uuid("requested_vehicle_unit_id")
      .notNull()
      .references(() => vehicleUnit.id, { onDelete: "restrict" }),
    contractId: uuid("contract_id"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    requestedByRole: text("requested_by_role").notNull(),
    approvedBy: uuid("approved_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    approvedByRole: text("approved_by_role"),
    status: text("status").notNull().default("PENDING"),
    reason: text("reason").notNull(),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }).notNull(),
    effectiveUntil: timestamp("effective_until", { withTimezone: true }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("vehicle_reassignment_approval_pending_unique")
      .on(table.applicationId, table.previousAssignmentId, table.requestedVehicleUnitId)
      .where(sql`${table.status} in ('PENDING', 'APPROVED')`),
    check(
      "vehicle_reassignment_approval_status_allowed",
      sql`${table.status} in ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')`,
    ),
    check(
      "vehicle_reassignment_approval_reason_nonempty",
      sql`length(btrim(${table.reason})) > 0`,
    ),
    check(
      "vehicle_reassignment_approval_window_ordered",
      sql`${table.effectiveUntil} is null or ${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
    check(
      "vehicle_reassignment_approval_approved_consistent",
      sql`(${table.status} <> 'APPROVED' and ${table.approvedBy} is null and ${table.approvedAt} is null) or (${table.status} = 'APPROVED' and ${table.approvedBy} is not null and ${table.approvedByRole} is not null and ${table.approvedAt} is not null)`,
    ),
  ],
);

export const insuranceRecord = pgTable(
  "insurance_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vehicleUnitId: uuid("vehicle_unit_id")
      .notNull()
      .references(() => vehicleUnit.id, { onDelete: "restrict" }),
    policyNumber: text("policy_number").notNull(),
    provider: text("provider").notNull(),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to").notNull(),
    evidenceDocumentId: uuid("evidence_document_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("insurance_policy_number_unique").on(table.policyNumber),
    check("insurance_date_order", sql`${table.validTo} >= ${table.validFrom}`),
  ],
);

export const registrationRecord = pgTable(
  "registration_record",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vehicleUnitId: uuid("vehicle_unit_id")
      .notNull()
      .references(() => vehicleUnit.id, { onDelete: "restrict" }),
    registrationNumber: text("registration_number").notNull(),
    registeredOwner: registrationOwner("registered_owner")
      .notNull()
      .default("SOMOCO"),
    validFrom: date("valid_from").notNull(),
    validTo: date("valid_to"),
    evidenceDocumentId: uuid("evidence_document_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [index("registration_vehicle_idx").on(table.vehicleUnitId)],
);

export const trackerAssociation = pgTable(
  "tracker_association",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vehicleUnitId: uuid("vehicle_unit_id")
      .notNull()
      .references(() => vehicleUnit.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    providerDeviceId: text("provider_device_id").notNull(),
    deepLink: text("deep_link").notNull(),
    associatedAt: timestamp("associated_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("tracker_provider_device_unique").on(
      table.provider,
      table.providerDeviceId,
    ),
  ],
);

export const trackerAccessLog = pgTable(
  "tracker_access_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    trackerAssociationId: uuid("tracker_association_id")
      .notNull()
      .references(() => trackerAssociation.id, { onDelete: "restrict" }),
    actorStaffUserId: uuid("actor_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    recoveryCaseId: uuid("recovery_case_id"),
    purpose: text("purpose").notNull(),
    accessedAt: timestamp("accessed_at", { withTimezone: true }).notNull(),
    context: jsonb("context")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
  },
  (table) => [index("tracker_access_actor_idx").on(table.actorStaffUserId)],
);
