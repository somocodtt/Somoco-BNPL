import { auditEvent } from "../schema/audit.js";
import type { DatabaseExecutor } from "../transaction.js";

export type NewAuditEvent = typeof auditEvent.$inferInsert;

export async function appendAuditEvent(
  db: DatabaseExecutor,
  event: NewAuditEvent,
) {
  const [inserted] = await db.insert(auditEvent).values(event).returning();
  if (inserted === undefined) {
    throw new Error("AUDIT_EVENT_APPEND_FAILED");
  }
  return inserted;
}
