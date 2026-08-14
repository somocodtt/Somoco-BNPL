import { asc, eq } from "drizzle-orm";
import { auditEvent } from "../schema/audit.js";
import type { Database } from "../client.js";
import {
  getInternalExecutor,
  type DatabaseTransaction,
} from "../transaction.js";

export type NewAuditEvent = typeof auditEvent.$inferInsert;

export async function appendAuditEvent(
  db: Database | DatabaseTransaction,
  event: NewAuditEvent,
) {
  const [inserted] = await getInternalExecutor(db)
    .insert(auditEvent)
    .values(event)
    .returning();
  if (inserted === undefined) {
    throw new Error("AUDIT_EVENT_APPEND_FAILED");
  }
  return inserted;
}

export async function listAuditEventsByActor(
  db: Database | DatabaseTransaction,
  staffUserId: string,
) {
  return getInternalExecutor(db)
    .select()
    .from(auditEvent)
    .where(eq(auditEvent.actorStaffUserId, staffUserId))
    .orderBy(asc(auditEvent.recordedAt));
}
