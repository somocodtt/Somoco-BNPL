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
import { application, exceptionRequest } from "./applications.js";
import { staffUser } from "./access.js";
import { person } from "./privacy.js";

export const exceptionDecision = pgTable(
  "exception_decision",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    exceptionRequestId: uuid("exception_request_id")
      .notNull()
      .references(() => exceptionRequest.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    status: text("status").notNull(),
    decidedBy: uuid("decided_by")
      .notNull()
      .references(() => staffUser.id, { onDelete: "restrict" }),
    reason: text("reason").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("exception_decision_request_version_unique").on(
      table.exceptionRequestId,
      table.version,
    ),
    check(
      "exception_decision_status_allowed",
      sql`${table.status} in ('APPROVED', 'REJECTED')`,
    ),
  ],
);

export const financingCommand = pgTable(
  "financing_command",
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
    actorPersonId: uuid("actor_person_id").references(() => person.id, {
      onDelete: "restrict",
    }),
    applicationId: uuid("application_id").references(() => application.id, {
      onDelete: "restrict",
    }),
    response: jsonb("response").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("financing_command_scope_key_unique").on(
      table.scope,
      table.idempotencyKey,
    ),
    index("financing_command_application_idx").on(table.applicationId),
    check(
      "financing_command_type_allowed",
      sql`${table.commandType} in ('PRODUCT_PUBLISH', 'EXCEPTION_REQUEST', 'EXCEPTION_DECIDE', 'OFFER_CREATE', 'OFFER_ACCEPT')`,
    ),
    check(
      "financing_command_payload_hash_sha256",
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "financing_command_actor_exclusive",
      sql`(${table.actorStaffUserId} is null) <> (${table.actorPersonId} is null)`,
    ),
  ],
);
