import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Database } from "./client.js";
import { inboxMessage } from "./schema/integrations.js";
import {
  getInternalExecutor,
  type DatabaseTransaction,
} from "./transaction.js";

export interface InboxMessageInput {
  id?: string;
  provider: string;
  providerEventId: string;
  eventType: string;
  payload: unknown;
  receivedAt: Date;
}

export type InboxMessage = typeof inboxMessage.$inferSelect;
export type InboxReceipt = InboxMessage & {
  inserted: boolean;
  processingToken: string | null;
};

export async function receiveInboxMessage(
  db: Database | DatabaseTransaction,
  message: InboxMessageInput,
): Promise<InboxReceipt> {
  const executor = getInternalExecutor(db);
  const processingToken = randomUUID();
  const [inserted] = await executor
    .insert(inboxMessage)
    .values({
      ...message,
      processingToken,
      processingStartedAt: new Date(),
    })
    .onConflictDoNothing({
      target: [inboxMessage.provider, inboxMessage.providerEventId],
    })
    .returning();

  if (inserted !== undefined) {
    return { ...inserted, inserted: true };
  }

  const [existing] = await executor
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
  return { ...existing, inserted: false, processingToken: null };
}

export async function completeInboxMessage(
  db: Database | DatabaseTransaction,
  id: string,
  processingToken: string,
  result: unknown,
  processedAt = new Date(),
): Promise<InboxMessage> {
  const [updated] = await getInternalExecutor(db)
    .update(inboxMessage)
    .set({
      processedAt,
      result,
      processingToken: null,
      processingStartedAt: null,
    })
    .where(
      and(
        eq(inboxMessage.id, id),
        eq(inboxMessage.processingToken, processingToken),
        isNull(inboxMessage.processedAt),
      ),
    )
    .returning();
  if (updated === undefined) {
    throw new Error("INBOX_COMPLETION_NOT_OWNED");
  }
  return updated;
}
