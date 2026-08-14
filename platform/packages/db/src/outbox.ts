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

export interface ClaimedOutboxMessage extends OutboxMessage {
  leaseToken: string;
}

export type NewOutboxMessage = Omit<OutboxMessage, "attempts"> & {
  attempts?: number;
};

export interface ClaimOutboxBatchOptions {
  workerId: string;
  limit: number;
  claimLeaseMs?: number;
  maxAttempts?: number;
}

interface OwnedOutboxClaimInput {
  messageId: string;
  workerId: string;
  leaseToken: string;
}

export type HeartbeatOutboxClaimInput = OwnedOutboxClaimInput;
export type CompleteOutboxAttemptInput = OwnedOutboxClaimInput;

export interface FailOutboxAttemptInput extends OwnedOutboxClaimInput {
  failureCode: string;
}

export interface OutboxAttemptRecord {
  attemptNumber: number;
  workerId: string;
  attemptedAt: Date;
  finishedAt: Date | null;
  outcome:
    "STARTED" | "ABANDONED" | "PUBLISHED" | "RETRY_SCHEDULED" | "EXCEPTION";
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
  if (inserted === undefined) throw new Error("OUTBOX_ENQUEUE_FAILED");
  return toOutboxMessage(inserted);
}

export async function claimOutboxBatch(
  db: Database | DatabaseTransaction,
  options: ClaimOutboxBatchOptions,
): Promise<ClaimedOutboxMessage[]> {
  const claimLeaseMs = options.claimLeaseMs ?? 5 * 60_000;
  const maxAttempts = options.maxAttempts ?? 5;
  assertPositiveInteger(options.limit, 100, "OUTBOX_CLAIM_LIMIT_INVALID");
  assertPositiveInteger(
    claimLeaseMs,
    Number.MAX_SAFE_INTEGER,
    "OUTBOX_CLAIM_LEASE_INVALID",
  );
  assertPositiveInteger(
    maxAttempts,
    Number.MAX_SAFE_INTEGER,
    "OUTBOX_MAX_ATTEMPTS_INVALID",
  );

  const result = await getInternalExecutor(db).execute<{
    id: string;
    topic: string;
    aggregate_type: string;
    aggregate_id: string;
    payload: unknown;
    occurred_at: Date | string;
    attempts: number;
    claim_token: string;
  }>(sql`
    with database_time as materialized (select clock_timestamp() as now),
    exhausted_candidates as materialized (
      select message.id, message.attempts
      from ${outboxMessage} as message, database_time
      where message.published_at is null
        and message.exception_at is null
        and message.available_at <= database_time.now
        and message.attempts >= ${maxAttempts}
        and (message.claimed_by is null or message.claimed_at < database_time.now - (${claimLeaseMs} * interval '1 millisecond'))
      for update of message skip locked
    ),
    exhausted_attempts as (
      update ${outboxAttempt} as attempt
      set outcome = 'EXCEPTION',
          finished_at = database_time.now,
          failure_code = 'OUTBOX_MAX_ATTEMPTS_REACHED',
          next_attempt_at = null
      from exhausted_candidates, database_time
      where attempt.outbox_message_id = exhausted_candidates.id
        and attempt.attempt_number = exhausted_candidates.attempts
        and attempt.outcome = 'STARTED'
      returning attempt.outbox_message_id
    ),
    exhausted_messages as (
      update ${outboxMessage} as message
      set claimed_by = null,
          claim_token = null,
          claimed_at = null,
          exception_at = database_time.now,
          last_attempt_at = database_time.now,
          last_error = 'OUTBOX_MAX_ATTEMPTS_REACHED'
      from exhausted_candidates, database_time
      where message.id = exhausted_candidates.id
        and (message.claimed_by is null or exists (
          select 1 from exhausted_attempts where exhausted_attempts.outbox_message_id = message.id
        ))
      returning message.id
    ),
    candidates as materialized (
      select message.id,
             message.attempts,
             message.claimed_by is not null as was_abandoned
      from ${outboxMessage} as message, database_time
      where message.published_at is null
        and message.exception_at is null
        and message.available_at <= database_time.now
        and message.attempts < ${maxAttempts}
        and (message.claimed_by is null or message.claimed_at < database_time.now - (${claimLeaseMs} * interval '1 millisecond'))
      order by message.occurred_at, message.id
      for update of message skip locked
      limit ${options.limit}
    ),
    abandoned as (
      update ${outboxAttempt} as attempt
      set outcome = 'ABANDONED',
          finished_at = database_time.now,
          failure_code = 'OUTBOX_CLAIM_EXPIRED',
          next_attempt_at = null
      from candidates, database_time
      where candidates.was_abandoned
        and attempt.outbox_message_id = candidates.id
        and attempt.attempt_number = candidates.attempts
        and attempt.outcome = 'STARTED'
      returning attempt.outbox_message_id
    ),
    claimed as (
      update ${outboxMessage} as message
      set claimed_by = ${options.workerId},
          claim_token = gen_random_uuid(),
          claimed_at = database_time.now,
          attempts = message.attempts + 1
      from candidates, database_time
      where message.id = candidates.id
        and (not candidates.was_abandoned or exists (
          select 1 from abandoned where abandoned.outbox_message_id = message.id
        ))
      returning message.id,
                message.topic,
                message.aggregate_type,
                message.aggregate_id,
                message.payload,
                message.occurred_at,
                message.attempts,
                message.claim_token,
                message.claimed_at
    ),
    started as (
      insert into outbox_attempt (
        outbox_message_id, attempt_number, worker_id, lease_token, attempted_at, outcome
      )
      select claimed.id, claimed.attempts, ${options.workerId}, claimed.claim_token, claimed.claimed_at, 'STARTED'
      from claimed
      returning outbox_message_id
    )
    select claimed.id,
           claimed.topic,
           claimed.aggregate_type,
           claimed.aggregate_id,
           claimed.payload,
           claimed.occurred_at,
           claimed.attempts,
           claimed.claim_token
    from claimed
    join started on started.outbox_message_id = claimed.id
    order by claimed.occurred_at, claimed.id
  `);

  return result.rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    aggregateType: row.aggregate_type,
    aggregateId: row.aggregate_id,
    payload: row.payload,
    occurredAt: asDate(row.occurred_at),
    attempts: row.attempts,
    leaseToken: row.claim_token,
  }));
}

export async function heartbeatOutboxClaim(
  db: Database | DatabaseTransaction,
  input: HeartbeatOutboxClaimInput,
): Promise<boolean> {
  const result = await getInternalExecutor(db).execute<{ id: string }>(sql`
    update ${outboxMessage}
    set claimed_at = clock_timestamp()
    where id = ${input.messageId}
      and claimed_by = ${input.workerId}
      and claim_token = ${input.leaseToken}
      and published_at is null
      and exception_at is null
    returning id
  `);
  return result.rows.length === 1;
}

export async function completeOutboxAttempt(
  db: Database | DatabaseTransaction,
  input: CompleteOutboxAttemptInput,
): Promise<boolean> {
  return finishAttempt(db, input, { outcome: "PUBLISHED", failureCode: null });
}

export async function scheduleOutboxRetry(
  db: Database | DatabaseTransaction,
  input: FailOutboxAttemptInput & { retryDelayMs: number },
): Promise<boolean> {
  assertFailureCode(input.failureCode);
  assertPositiveInteger(
    input.retryDelayMs,
    Number.MAX_SAFE_INTEGER,
    "OUTBOX_RETRY_DELAY_INVALID",
  );
  return finishAttempt(db, input, {
    outcome: "RETRY_SCHEDULED",
    failureCode: input.failureCode,
    retryDelayMs: input.retryDelayMs,
  });
}

export async function exceptOutboxAttempt(
  db: Database | DatabaseTransaction,
  input: FailOutboxAttemptInput,
): Promise<boolean> {
  assertFailureCode(input.failureCode);
  return finishAttempt(db, input, {
    outcome: "EXCEPTION",
    failureCode: input.failureCode,
  });
}

async function finishAttempt(
  db: Database | DatabaseTransaction,
  input: OwnedOutboxClaimInput,
  result:
    | { outcome: "PUBLISHED"; failureCode: null }
    | { outcome: "RETRY_SCHEDULED"; failureCode: string; retryDelayMs: number }
    | { outcome: "EXCEPTION"; failureCode: string },
): Promise<boolean> {
  const retryDelayMs =
    result.outcome === "RETRY_SCHEDULED" ? result.retryDelayMs : 0;
  const completed = await getInternalExecutor(db).execute<{ id: string }>(sql`
    with database_time as materialized (select clock_timestamp() as now),
    owned as materialized (
      select message.id, message.attempts
      from ${outboxMessage} as message
      where message.id = ${input.messageId}
        and message.claimed_by = ${input.workerId}
        and message.claim_token = ${input.leaseToken}
        and message.published_at is null
        and message.exception_at is null
      for update of message
    ),
    finished_attempt as (
      update ${outboxAttempt} as attempt
      set outcome = ${result.outcome},
          finished_at = database_time.now,
          failure_code = ${result.failureCode},
          next_attempt_at = case
            when ${result.outcome} = 'RETRY_SCHEDULED'
              then database_time.now + (${retryDelayMs} * interval '1 millisecond')
            else null
          end
      from owned, database_time
      where attempt.outbox_message_id = owned.id
        and attempt.attempt_number = owned.attempts
        and attempt.worker_id = ${input.workerId}
        and attempt.lease_token = ${input.leaseToken}
        and attempt.outcome = 'STARTED'
      returning attempt.outbox_message_id, attempt.finished_at, attempt.next_attempt_at
    ),
    finished_message as (
      update ${outboxMessage} as message
      set claimed_by = null,
          claim_token = null,
          claimed_at = null,
          available_at = coalesce(finished_attempt.next_attempt_at, message.available_at),
          last_attempt_at = finished_attempt.finished_at,
          published_at = case when ${result.outcome} = 'PUBLISHED' then finished_attempt.finished_at else null end,
          exception_at = case when ${result.outcome} = 'EXCEPTION' then finished_attempt.finished_at else null end,
          last_error = ${result.failureCode}
      from finished_attempt
      where message.id = finished_attempt.outbox_message_id
      returning message.id
    )
    select id from finished_message
  `);
  return completed.rows.length === 1;
}

export async function listOutboxAttempts(
  db: Database | DatabaseTransaction,
  outboxMessageId: string,
): Promise<OutboxAttemptRecord[]> {
  const result = await getInternalExecutor(db).execute<{
    attempt_number: number;
    worker_id: string;
    attempted_at: Date | string;
    finished_at: Date | string | null;
    outcome: OutboxAttemptRecord["outcome"];
    failure_code: string | null;
    next_attempt_at: Date | string | null;
  }>(sql`
    select attempt_number, worker_id, attempted_at, finished_at, outcome, failure_code, next_attempt_at
    from ${outboxAttempt}
    where outbox_message_id = ${outboxMessageId}
    order by attempt_number
  `);
  return result.rows.map((row) => ({
    attemptNumber: row.attempt_number,
    workerId: row.worker_id,
    attemptedAt: asDate(row.attempted_at),
    finishedAt: row.finished_at === null ? null : asDate(row.finished_at),
    outcome: row.outcome,
    failureCode: row.failure_code,
    nextAttemptAt:
      row.next_attempt_at === null ? null : asDate(row.next_attempt_at),
  }));
}

function assertPositiveInteger(
  value: number,
  maximum: number,
  code: string,
): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new Error(code);
}

function assertFailureCode(code: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code))
    throw new Error("OUTBOX_FAILURE_CODE_INVALID");
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
