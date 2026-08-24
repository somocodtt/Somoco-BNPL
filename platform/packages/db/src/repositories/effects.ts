import { enqueueOutbox, type NewOutboxMessage } from "../outbox.js";
import type { DatabaseTransaction } from "../transaction.js";
import { appendAuditEvent, type NewAuditEvent } from "./audit.js";

export interface WriteEffects {
  audit: NewAuditEvent;
  outbox: NewOutboxMessage;
}

export async function persistWriteEffects(
  tx: DatabaseTransaction,
  effects: WriteEffects,
): Promise<void> {
  await appendAuditEvent(tx, effects.audit);
  await enqueueOutbox(tx, effects.outbox);
}
