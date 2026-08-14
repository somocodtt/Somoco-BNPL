import { sql } from "drizzle-orm";
import {
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

export const vehicleUnit = pgTable(
  "vehicle_unit",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    vehicleModelId: uuid("vehicle_model_id")
      .notNull()
      .references(() => vehicleModel.id, { onDelete: "restrict" }),
    vin: text("vin").notNull(),
    chassisNumber: text("chassis_number").notNull(),
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
    registeredOwner: text("registered_owner").notNull(),
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
