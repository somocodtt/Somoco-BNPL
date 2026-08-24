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
  /** Preserve an unverified payload without claiming it for processing. */
  claim?: boolean;
}

export type InboxMessage = typeof inboxMessage.$inferSelect;
export type InboxReceipt = InboxMessage & {
  inserted: boolean;
  processingToken: string | null;
};

export async function findInboxMessage(
  db: Database | DatabaseTransaction,
  provider: string,
  providerEventId: string,
): Promise<InboxMessage | null> {
  const [row] = await getInternalExecutor(db)
    .select()
    .from(inboxMessage)
    .where(
      and(
        eq(inboxMessage.provider, provider),
        eq(inboxMessage.providerEventId, providerEventId),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function receiveInboxMessage(
  db: Database | DatabaseTransaction,
  message: InboxMessageInput,
): Promise<InboxReceipt> {
  const executor = getInternalExecutor(db);
  const { claim, ...persistedMessage } = message;
  const processingToken = claim === false ? null : randomUUID();
  const [inserted] = await executor
    .insert(inboxMessage)
    .values({
      ...persistedMessage,
      processingToken,
      processingStartedAt: processingToken === null ? null : new Date(),
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
  if (
    message.claim !== false &&
    existing.processedAt === null &&
    existing.processingToken === null
  ) {
    const [claimed] = await executor
      .update(inboxMessage)
      .set({
        processingToken,
        processingStartedAt: new Date(),
      })
      .where(
        and(
          eq(inboxMessage.id, existing.id),
          isNull(inboxMessage.processedAt),
          isNull(inboxMessage.processingToken),
        ),
      )
      .returning();
    if (claimed !== undefined)
      return { ...claimed, inserted: false, processingToken };
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
