import { and, eq } from "drizzle-orm";
import { inboxMessage } from "./schema/integrations.js";
import type { DatabaseExecutor } from "./transaction.js";

export interface InboxMessageInput {
  id?: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: unknown;
  receivedAt: Date;
}

export type InboxMessage = typeof inboxMessage.$inferSelect;

export async function receiveInboxMessage(
  db: DatabaseExecutor,
  message: InboxMessageInput,
): Promise<InboxMessage> {
  const [inserted] = await db
    .insert(inboxMessage)
    .values(message)
    .onConflictDoNothing({
      target: [inboxMessage.provider, inboxMessage.providerEventId],
    })
    .returning();

  if (inserted !== undefined) {
    return inserted;
  }

  const [existing] = await db
    .select()
    .from(inboxMessage)
    .where(
      and(
        eq(inboxMessage.provider, message.provider),
        eq(inboxMessage.providerEventId, message.providerEventId),
      ),
    )
    .limit(1);

  if (existing === undefined) {
    throw new Error("INBOX_DEDUPLICATION_FAILED");
  }
  return existing;
}

export async function completeInboxMessage(
  db: DatabaseExecutor,
  id: string,
  result: unknown,
  processedAt = new Date(),
): Promise<InboxMessage> {
  const [updated] = await db
    .update(inboxMessage)
    .set({ processedAt, result })
    .where(eq(inboxMessage.id, id))
    .returning();
  if (updated === undefined) {
    throw new Error("INBOX_MESSAGE_NOT_FOUND");
  }
  return updated;
}
