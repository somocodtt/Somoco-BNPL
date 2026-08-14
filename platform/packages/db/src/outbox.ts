import { sql } from "drizzle-orm";
import type { Database } from "./client.js";
import { outboxAttempt, outboxMessage } from "./schema/integrations.js";
import {
  getInternalExecutor,
  type DatabaseTransaction,
} from "./transaction.js";

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
  claimedAt?: Date;
  staleBefore?: Date;
}

export interface HeartbeatOutboxClaimInput {
  messageId: string;
  workerId: string;
  heartbeatAt: Date;
}

export interface CompleteOutboxAttemptInput {
  messageId: string;
  workerId: string;
  attemptedAt: Date;
  publishedAt: Date;
}

export interface FailOutboxAttemptInput {
  messageId: string;
  workerId: string;
  attemptedAt: Date;
  failureCode: string;
}

export interface OutboxAttemptRecord {
  attemptNumber: number;
  workerId: string;
  attemptedAt: Date;
  outcome: "PUBLISHED" | "RETRY_SCHEDULED" | "EXCEPTION";
  failureCode: string | null;
  nextAttemptAt: Date | null;
}

export async function enqueueOutbox(
  db: Database | DatabaseTransaction,
  message: NewOutboxMessage,
): Promise<OutboxMessage> {
  const [inserted] = await getInternalExecutor(db)
    .insert(outboxMessage)
    .values({ ...message, availableAt: message.occurredAt })
    .returning();
  if (inserted === undefined) {
    throw new Error("OUTBOX_ENQUEUE_FAILED");
  }
  return toOutboxMessage(inserted);
}

export async function claimOutboxBatch(
  db: Database | DatabaseTransaction,
  options: ClaimOutboxBatchOptions,
): Promise<OutboxMessage[]> {
  if (
    !Number.isInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new Error("OUTBOX_CLAIM_LIMIT_INVALID");
  }

  const claimedAt = options.claimedAt ?? new Date();
  const staleBefore =
    options.staleBefore ?? new Date(claimedAt.getTime() - 5 * 60_000);
  const result = await getInternalExecutor(db).execute<{
    id: string;
    topic: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: unknown;
    occurred_at: Date | string;
    attempts: number;
  }>(sql`
    with candidates as (
      select id
      from ${outboxMessage}
      where published_at is null
        and exception_at is null
        and available_at <= ${claimedAt}
        and (claimed_by is null or claimed_at < ${staleBefore})
      order by occurred_at, id
      for update skip locked
      limit ${options.limit}
    )
    update ${outboxMessage} as message
    set claimed_by = ${options.workerId},
        claimed_at = ${claimedAt},
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
    occurredAt: asDate(row.occurred_at),
    attempts: row.attempts,
  }));
}

export async function heartbeatOutboxClaim(
  db: Database | DatabaseTransaction,
  input: HeartbeatOutboxClaimInput,
): Promise<boolean> {
  const result = await getInternalExecutor(db).execute<{ id: string }>(sql`
    update ${outboxMessage}
    set claimed_at = ${input.heartbeatAt}
    where id = ${input.messageId}
      and claimed_by = ${input.workerId}
      and published_at is null
      and exception_at is null
      and claimed_at <= ${input.heartbeatAt}
    returning id
  `);
  return result.rows.length === 1;
}

export async function completeOutboxAttempt(
  db: Database | DatabaseTransaction,
  input: CompleteOutboxAttemptInput,
): Promise<boolean> {
  const result = await getInternalExecutor(db).execute<{ id: string }>(sql`
    with completed as (
      update ${outboxMessage}
      set claimed_by = null,
          claimed_at = null,
          published_at = ${input.publishedAt},
          last_attempt_at = ${input.attemptedAt},
          last_error = null
      where id = ${input.messageId}
        and claimed_by = ${input.workerId}
        and published_at is null
        and exception_at is null
      returning id, attempts
    )
    insert into outbox_attempt (
      outbox_message_id,
      attempt_number,
      worker_id,
      attempted_at,
      outcome
    )
    select id, attempts, ${input.workerId}, ${input.attemptedAt}, 'PUBLISHED'
    from completed
    returning id
  `);
  return result.rows.length === 1;
}

export async function scheduleOutboxRetry(
  db: Database | DatabaseTransaction,
  input: FailOutboxAttemptInput & { nextAttemptAt: Date },
): Promise<boolean> {
  assertFailureCode(input.failureCode);
  const result = await getInternalExecutor(db).execute<{ id: string }>(sql`
    with retried as (
      update ${outboxMessage}
      set claimed_by = null,
          claimed_at = null,
          available_at = ${input.nextAttemptAt},
          last_attempt_at = ${input.attemptedAt},
          last_error = ${input.failureCode}
      where id = ${input.messageId}
        and claimed_by = ${input.workerId}
        and published_at is null
        and exception_at is null
      returning id, attempts
    )
    insert into outbox_attempt (
      outbox_message_id,
      attempt_number,
      worker_id,
      attempted_at,
      outcome,
      failure_code,
      next_attempt_at
    )
    select id,
           attempts,
           ${input.workerId},
           ${input.attemptedAt},
           'RETRY_SCHEDULED',
           ${input.failureCode},
           ${input.nextAttemptAt}
    from retried
    returning id
  `);
  return result.rows.length === 1;
}

export async function exceptOutboxAttempt(
  db: Database | DatabaseTransaction,
  input: FailOutboxAttemptInput & { exceptionAt: Date },
): Promise<boolean> {
  assertFailureCode(input.failureCode);
  const result = await getInternalExecutor(db).execute<{ id: string }>(sql`
    with excepted as (
      update ${outboxMessage}
      set claimed_by = null,
          claimed_at = null,
          exception_at = ${input.exceptionAt},
          last_attempt_at = ${input.attemptedAt},
          last_error = ${input.failureCode}
      where id = ${input.messageId}
        and claimed_by = ${input.workerId}
        and published_at is null
        and exception_at is null
      returning id, attempts
    )
    insert into outbox_attempt (
      outbox_message_id,
      attempt_number,
      worker_id,
      attempted_at,
      outcome,
      failure_code
    )
    select id,
           attempts,
           ${input.workerId},
           ${input.attemptedAt},
           'EXCEPTION',
           ${input.failureCode}
    from excepted
    returning id
  `);
  return result.rows.length === 1;
}

export async function listOutboxAttempts(
  db: Database | DatabaseTransaction,
  outboxMessageId: string,
): Promise<OutboxAttemptRecord[]> {
  const result = await getInternalExecutor(db).execute<{
    attempt_number: number;
    worker_id: string;
    attempted_at: Date | string;
    outcome: OutboxAttemptRecord["outcome"];
    failure_code: string | null;
    next_attempt_at: Date | string | null;
  }>(sql`
    select attempt_number,
           worker_id,
           attempted_at,
           outcome,
           failure_code,
           next_attempt_at
    from ${outboxAttempt}
    where outbox_message_id = ${outboxMessageId}
    order by attempt_number
  `);
  return result.rows.map((row) => ({
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    attemptedAt: asDate(row.attempted_at),
    outcome: row.outcome,
    failureCode: row.failure_code,
    nextAttemptAt:
      row.next_attempt_at === null ? null : asDate(row.next_attempt_at),
  }));
}

function assertFailureCode(code: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
    throw new Error("OUTBOX_FAILURE_CODE_INVALID");
  }
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
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
