import {
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { staffUser } from "./access.js";

export const auditEvent = pgTable(
  "audit_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    aggregateType: text("aggregate_type").notNull(),
    aggregateId: uuid("aggregate_id").notNull(),
    action: text("action").notNull(),
    actorStaffUserId: uuid("actor_staff_user_id").references(
      () => staffUser.id,
      {
        onDelete: "restrict",
      },
    ),
    requestId: uuid("request_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("audit_aggregate_idx").on(table.aggregateType, table.aggregateId),
    index("audit_occurred_idx").on(table.occurredAt),
  ],
);
