// prettier-ignore
import type { ApplicationStatus, ApprovalStage } from "@somo/domain/src/application-state.js";
import { sql } from "drizzle-orm";
import {
  check,
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
import { person } from "./privacy.js";
import { product, vehicleModel } from "./products.js";

const APPLICATION_STATUSES = [
  "DRAFT",
  "AWAITING_GUARANTOR",
  "READY_TO_SUBMIT",
  "VERIFICATION_REVIEW",
  "BSM_INITIAL_REVIEW",
  "AGM_REVIEW",
  "CFO_REVIEW",
  "BSM_FINAL_REVIEW",
  "MD_REVIEW",
  "INFORMATION_REQUESTED",
  "REJECTED",
  "APPROVED",
  "AWAITING_DEPOSIT",
  "AWAITING_ASSET_ASSIGNMENT",
  "AWAITING_EXECUTION",
  "ACTIVE",
  "SETTLED",
  "RECOVERY",
] as const satisfies readonly ApplicationStatus[];

const APPROVAL_STAGES = [
  "VERIFICATION",
  "BSM_INITIAL",
  "AGM",
  "CFO",
  "BSM_FINAL",
  "MD",
] as const satisfies readonly ApprovalStage[];

export const applicationStatus = pgEnum(
  "application_status",
  APPLICATION_STATUSES,
);
export const approvalStage = pgEnum("approval_stage", APPROVAL_STAGES);
export const approvalAction = pgEnum("approval_action", [
  "APPROVE",
  "REJECT",
  "REQUEST_INFORMATION",
]);
export const guarantorStatus = pgEnum("guarantor_status", [
  "INVITED",
  "IN_PROGRESS",
  "CONFIRMED",
  "DECLINED",
]);

export const customerProfile = pgTable(
  "customer_profile",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    profileData: jsonb("profile_data")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("customer_profile_person_unique").on(table.personId),
    check("customer_profile_version_positive", sql`${table.version} > 0`),
  ],
);

export const application = pgTable(
  "application",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicantPersonId: uuid("applicant_person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    productId: uuid("product_id").references(() => product.id, {
      onDelete: "restrict",
    }),
    vehicleModelId: uuid("vehicle_model_id").references(() => vehicleModel.id, {
      onDelete: "restrict",
    }),
    status: applicationStatus("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("application_applicant_idx").on(table.applicantPersonId),
    index("application_status_idx").on(table.status),
    check("application_version_positive", sql`${table.version} > 0`),
  ],
);

export const guarantorRelationship = pgTable(
  "guarantor_relationship",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    guarantorPersonId: uuid("guarantor_person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    status: guarantorStatus("status").notNull().default("INVITED"),
    version: integer("version").notNull().default(1),
    invitedAt: timestamp("invited_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("guarantor_application_person_unique").on(
      table.applicationId,
      table.guarantorPersonId,
    ),
    check("guarantor_relationship_version_positive", sql`${table.version} > 0`),
  ],
);

export const applicationVersion = pgTable(
  "application_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("application_version_number_unique").on(
      table.applicationId,
      table.versionNumber,
    ),
    check(
      "application_version_number_positive",
      sql`${table.versionNumber} > 0`,
    ),
  ],
);

export const underwritingAssessment = pgTable(
  "underwriting_assessment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationVersionId: uuid("application_version_id")
      .notNull()
      .references(() => applicationVersion.id, { onDelete: "restrict" }),
    assessment: jsonb("assessment").$type<Record<string, unknown>>().notNull(),
    assessedBy: uuid("assessed_by").references(() => staffUser.id, {
      onDelete: "restrict",
    }),
    assessedAt: timestamp("assessed_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("underwriting_application_version_idx").on(
      table.applicationVersionId,
    ),
  ],
);

export const approvalDecision = pgTable(
  "approval_decision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationVersionId: uuid("application_version_id")
      .notNull()
      .references(() => applicationVersion.id, { onDelete: "restrict" }),
    stage: approvalStage("stage").notNull(),
    action: approvalAction("action").notNull(),
    reason: text("reason"),
    decidedBy: uuid("decided_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("approval_decision_application_stage_idx").on(
      table.applicationVersionId,
      table.stage,
    ),
  ],
);

export const exceptionRequest = pgTable(
  "exception_request",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    proposedValue: jsonb("proposed_value").$type<unknown>().notNull(),
    policyValue: jsonb("policy_value").$type<unknown>().notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("PENDING"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
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
      "exception_request_status_allowed",
      sql`${table.status} in ('PENDING', 'APPROVED', 'REJECTED')`,
    ),
    check("exception_request_version_positive", sql`${table.version} > 0`),
  ],
);
