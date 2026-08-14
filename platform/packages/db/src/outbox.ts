import { sql } from "drizzle-orm";
import { outboxMessage } from "./schema/integrations.js";
import type { DatabaseExecutor } from "./transaction.js";

export interface OutboxMessage {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
}

export type NewOutboxMessage = Omit<OutboxMessage, "attempts"> & {
  attempts?: number;
};

export interface ClaimOutboxBatchOptions {
  workerId: string;
  limit: number;
  staleBefore?: Date;
}

export async function enqueueOutbox(
  db: DatabaseExecutor,
  message: NewOutboxMessage,
): Promise<OutboxMessage> {
  const [inserted] = await db.insert(outboxMessage).values(message).returning();
  if (inserted === undefined) {
    throw new Error("OUTBOX_ENQUEUE_FAILED");
  }
  return toOutboxMessage(inserted);
}

export async function claimOutboxBatch(
  db: DatabaseExecutor,
  options: ClaimOutboxBatchOptions,
): Promise<OutboxMessage[]> {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new Error("OUTBOX_CLAIM_LIMIT_INVALID");
  }

  const staleBefore = options.staleBefore ?? new Date(Date.now() - 5 * 60_000);
  const result = await db.execute<{
    id: string;
    topic: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: unknown;
    occurred_at: Date;
    attempts: number;
  }>(sql`
    with candidates as (
      select id
      from ${outboxMessage}
      where published_at is null
        and (claimed_at is null or claimed_at < ${staleBefore})
      order by occurred_at, id
      for update skip locked
      limit ${options.limit}
    )
    update ${outboxMessage} as message
    set claimed_by = ${options.workerId},
        claimed_at = now(),
        attempts = message.attempts + 1
    from candidates
    where message.id = candidates.id
    returning message.id,
              message.topic,
              message.aggregate_type,
              message.aggregate_id,
              message.payload,
              message.occurred_at,
              message.attempts
  `);

  return result.rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
    attempts: row.attempts,
  }));
}

function toOutboxMessage(
  record: typeof outboxMessage.$inferSelect,
): OutboxMessage {
  return {
    id: record.id,
    topic: record.topic,
    aggregateType: record.aggregateType,
    aggregateId: record.aggregateId,
    payload: record.payload,
    occurredAt: record.occurredAt,
    attempts: record.attempts,
  };
}
