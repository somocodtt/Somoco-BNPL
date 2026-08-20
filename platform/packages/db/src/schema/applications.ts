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
    informationRequestedStage: approvalStage("information_requested_stage"),
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
    uniqueIndex("guarantor_relationship_application_unique").on(
      table.applicationId,
    ),
    uniqueIndex("guarantor_application_person_unique").on(
      table.applicationId,
      table.guarantorPersonId,
    ),
    check("guarantor_relationship_version_positive", sql`${table.version} > 0`),
  ],
);

export const guarantorInvitation = pgTable(
  "guarantor_invitation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    guarantorPersonId: uuid("guarantor_person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    claimedByPersonId: uuid("claimed_by_person_id").references(
      () => person.id,
      { onDelete: "restrict" },
    ),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("guarantor_invitation_token_hash_unique").on(table.tokenHash),
    uniqueIndex("guarantor_invitation_application_active_unique")
      .on(table.applicationId)
      .where(sql`${table.claimedAt} is null and ${table.revokedAt} is null`),
    index("guarantor_invitation_guarantor_idx").on(table.guarantorPersonId),
    check(
      "guarantor_invitation_token_hash_sha256",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "guarantor_invitation_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "guarantor_invitation_claim_consistent",
      sql`(${table.claimedAt} is null) = (${table.claimedByPersonId} is null)`,
    ),
    check(
      "guarantor_invitation_claim_target_matches",
      sql`${table.claimedByPersonId} is null or ${table.claimedByPersonId} = ${table.guarantorPersonId}`,
    ),
    check(
      "guarantor_invitation_terminal_state_exclusive",
      sql`not (${table.claimedAt} is not null and ${table.revokedAt} is not null)`,
    ),
  ],
);

export const applicationMutation = pgTable(
  "application_mutation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    actorPersonId: uuid("actor_person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    mutationId: uuid("mutation_id").notNull(),
    operation: text("operation").notNull(),
    payloadHash: text("payload_hash").notNull(),
    result: jsonb("result").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("application_mutation_actor_idempotency_unique").on(
      table.actorPersonId,
      table.mutationId,
    ),
    index("application_mutation_application_idx").on(table.applicationId),
    check(
      "application_mutation_operation_safe",
      sql`${table.operation} ~ '^[A-Z][A-Z0-9_]{1,63}$'`,
    ),
    check(
      "application_mutation_payload_hash_sha256",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
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

export const workflowCommand = pgTable(
  "workflow_command",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    idempotencyKey: uuid("idempotency_key").notNull(),
    commandType: text("command_type").notNull(),
    payloadHash: text("payload_hash").notNull(),
    requestId: uuid("request_id").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(
      () => staffUser.id,
      { onDelete: "restrict" },
    ),
    actorPersonId: uuid("actor_person_id").references(() => person.id, {
      onDelete: "restrict",
    }),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("workflow_command_application_key_unique").on(
      table.applicationId,
      table.idempotencyKey,
    ),
    index("workflow_command_application_idx").on(table.applicationId),
    check(
      "workflow_command_type_allowed",
      sql`${table.commandType} in ('APPROVAL', 'RESUBMISSION', 'MANUAL_CREDIT_BUREAU')`,
    ),
    check(
      "workflow_command_payload_hash_sha256",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "workflow_command_actor_exclusive",
      sql`(${table.actorStaffUserId} is null) <> (${table.actorPersonId} is null)`,
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

export const staffDelegation = pgTable(
  "staff_delegation",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    delegatedStaffUserId: uuid("delegated_staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    delegatedRole: text("delegated_role").notNull(),
    scope: jsonb("scope").$type<string[]>().notNull(),
    approvedBy: uuid("approved_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    effectiveFrom: timestamp("effective_from", {
      withTimezone: true,
    }).notNull(),
    effectiveUntil: timestamp("effective_until", {
      withTimezone: true,
    }).notNull(),
    status: text("status").notNull().default("PENDING"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("staff_delegation_delegate_idx").on(
      table.delegatedStaffUserId,
      table.status,
    ),
    check(
      "staff_delegation_role_allowed",
      sql`${table.delegatedRole} in ('VERIFICATION_OFFICER', 'BSM', 'AGM', 'CFO', 'MD')`,
    ),
    check(
      "staff_delegation_status_allowed",
      sql`${table.status} in ('PENDING', 'APPROVED', 'REVOKED', 'EXPIRED')`,
    ),
    check(
      "staff_delegation_window_ordered",
      sql`${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
    check(
      "staff_delegation_approval_consistent",
      sql`(${table.status} = 'APPROVED') = (${table.approvedAt} is not null)`,
    ),
  ],
);
