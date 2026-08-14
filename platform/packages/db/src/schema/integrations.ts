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

export const inboxMessage = pgTable(
  "inbox_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    provider: text("provider").notNull(),
    providerEventId: text("provider_event_id").notNull(),
    eventType: text("event_type").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    result: jsonb("result").$type<unknown>(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    processingToken: uuid("processing_token"),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
  },
  (table) => [
    uniqueIndex("inbox_provider_event_unique").on(
      table.provider,
      table.providerEventId,
    ),
    index("inbox_unprocessed_idx")
      .on(table.receivedAt)
      .where(sql`${table.processedAt} is null`),
    check(
      "inbox_processing_lease_consistent",
      sql`(${table.processingToken} is null) = (${table.processingStartedAt} is null)`,
    ),
  ],
);

export const outboxMessage = pgTable(
  "outbox_message",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    topic: text("topic").notNull(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    payload: jsonb("payload").$type<unknown>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    claimedBy: text("claimed_by"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    availableAt: timestamp("available_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    exceptionAt: timestamp("exception_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("outbox_dispatch_idx").on(
      table.publishedAt,
      table.exceptionAt,
      table.availableAt,
      table.claimedAt,
      table.occurredAt,
    ),
    check("outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "outbox_claim_consistent",
      sql`(${table.claimedBy} is null) = (${table.claimedAt} is null)`,
    ),
    check(
      "outbox_terminal_state_exclusive",
      sql`not (${table.publishedAt} is not null and ${table.exceptionAt} is not null)`,
    ),
  ],
);

export const outboxAttempt = pgTable(
  "outbox_attempt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    outboxMessageId: uuid("outbox_message_id")
      .notNull()
      .references(() => outboxMessage.id, { onDelete: "restrict" }),
    attemptNumber: integer("attempt_number").notNull(),
    workerId: text("worker_id").notNull(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
    outcome: text("outcome").notNull(),
    failureCode: text("failure_code"),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("outbox_attempt_number_unique").on(
      table.outboxMessageId,
      table.attemptNumber,
    ),
    check("outbox_attempt_number_positive", sql`${table.attemptNumber} > 0`),
    check(
      "outbox_attempt_outcome_allowed",
      sql`${table.outcome} in ('PUBLISHED', 'RETRY_SCHEDULED', 'EXCEPTION')`,
    ),
    check(
      "outbox_attempt_failure_code_safe",
      sql`${table.failureCode} is null or ${table.failureCode} ~ '^[A-Z][A-Z0-9_]{0,63}$'`,
    ),
    check(
      "outbox_attempt_outcome_consistent",
      sql`(
        (${table.outcome} = 'PUBLISHED' and ${table.failureCode} is null and ${table.nextAttemptAt} is null)
        or (${table.outcome} = 'RETRY_SCHEDULED' and ${table.failureCode} is not null and ${table.nextAttemptAt} is not null)
        or (${table.outcome} = 'EXCEPTION' and ${table.failureCode} is not null and ${table.nextAttemptAt} is null)
      )`,
    ),
  ],
);

export const notificationStatus = pgEnum("notification_status", [
  "QUEUED",
  "SENT",
  "DELIVERED",
  "FAILED",
]);

export const notification = pgTable(
  "notification",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channel: text("channel").notNull(),
    recipientReference: text("recipient_reference").notNull(),
    template: text("template").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: notificationStatus("status").notNull().default("QUEUED"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("notification_idempotency_unique").on(table.idempotencyKey),
    check("notification_version_positive", sql`${table.version} > 0`),
  ],
);

export const deliveryAttempt = pgTable(
  "delivery_attempt",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    notificationId: uuid("notification_id")
      .notNull()
      .references(() => notification.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    providerReference: text("provider_reference"),
    attemptNumber: integer("attempt_number").notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("delivery_attempt_number_unique").on(
      table.notificationId,
      table.attemptNumber,
    ),
    check("delivery_attempt_number_positive", sql`${table.attemptNumber} > 0`),
  ],
);
