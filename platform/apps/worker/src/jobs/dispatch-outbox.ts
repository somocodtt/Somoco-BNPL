import type { OutboxMessage } from "@somo/db";

const failureCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

export type WorkerLogRecord = Readonly<Record<string, unknown>>;

export interface WorkerLogger {
  info(record: WorkerLogRecord): void;
  error(record: WorkerLogRecord): void;
}

export interface ClaimOutboxOptions {
  workerId: string;
  limit: number;
  claimedAt: Date;
  staleBefore: Date;
}

export interface HeartbeatOutboxClaim {
  messageId: string;
  workerId: string;
  heartbeatAt: Date;
}

export interface CompleteOutboxAttempt {
  messageId: string;
  workerId: string;
  attemptedAt: Date;
  publishedAt: Date;
}

export interface FailOutboxAttempt {
  messageId: string;
  workerId: string;
  attemptedAt: Date;
  failureCode: string;
}

export interface OutboxClaimStore {
  claim(options: ClaimOutboxOptions): Promise<OutboxMessage[]>;
  heartbeat(input: HeartbeatOutboxClaim): Promise<boolean>;
  complete(input: CompleteOutboxAttempt): Promise<boolean>;
  retry(input: FailOutboxAttempt & { nextAttemptAt: Date }): Promise<boolean>;
  except(input: FailOutboxAttempt & { exceptionAt: Date }): Promise<boolean>;
}

export type OutboxHandler = (message: OutboxMessage) => Promise<unknown>;

export interface DispatchOutboxOptions {
  store: OutboxClaimStore;
  workerId: string;
  handlers: ReadonlyMap<string, OutboxHandler>;
  concurrency: number;
  maxAttempts: number;
  retryBaseDelayMs: number;
  heartbeatIntervalMs: number;
  claimLeaseMs: number;
  now: () => Date;
  logger: WorkerLogger;
}

export class PermanentWorkerError extends Error {
  readonly code: string;
  readonly retryable = false;

  constructor(code: string) {
    if (!failureCodePattern.test(code)) {
      throw new Error("WORKER_FAILURE_CODE_INVALID");
    }
    super("PERMANENT_WORKER_FAILURE");
    this.name = "PermanentWorkerError";
    this.code = code;
  }
}

interface SanitizedFailure {
  code: string;
  retryable: boolean;
}

export async function dispatchOutboxBatch(
  options: DispatchOutboxOptions,
): Promise<number> {
  validateDispatchOutboxOptions(options);
  const claimedAt = options.now();
  const messages = await options.store.claim({
    workerId: options.workerId,
    limit: options.concurrency,
    claimedAt,
    staleBefore: new Date(claimedAt.getTime() - options.claimLeaseMs),
  });

  if (messages.length === 0) return 0;

  options.logger.info({
    event: "outbox.claimed",
    workerId: options.workerId,
    messageCount: messages.length,
  });
  await Promise.all(
    messages.map((message) => dispatchMessage(options, message)),
  );
  return messages.length;
}

async function dispatchMessage(
  options: DispatchOutboxOptions,
  message: OutboxMessage,
): Promise<void> {
  const handler = options.handlers.get(message.topic);
  try {
    if (handler === undefined) {
      throw new PermanentWorkerError("OUTBOX_HANDLER_NOT_FOUND");
    }
    await runWithHeartbeat(options, message, () => handler(message));
    const attemptedAt = options.now();
    const persisted = await options.store.complete({
      messageId: message.id,
      workerId: options.workerId,
      attemptedAt,
      publishedAt: attemptedAt,
    });
    if (!persisted) {
      logClaimLost(options, message);
      return;
    }
    options.logger.info({
      event: "outbox.dispatched",
      workerId: options.workerId,
      outboxMessageId: message.id,
      topic: message.topic,
      attempt: message.attempts,
    });
  } catch (cause) {
    await persistFailure(options, message, sanitizeFailure(cause));
  }
}

async function runWithHeartbeat(
  options: DispatchOutboxOptions,
  message: OutboxMessage,
  operation: () => Promise<unknown>,
): Promise<void> {
  let heartbeatChain = Promise.resolve();
  const heartbeat = () => {
    heartbeatChain = heartbeatChain
      .then(async () => {
        const persisted = await options.store.heartbeat({
          messageId: message.id,
          workerId: options.workerId,
          heartbeatAt: options.now(),
        });
        if (!persisted) logClaimLost(options, message);
      })
      .catch((cause: unknown) => {
        options.logger.error({
          event: "outbox.heartbeat_failed",
          workerId: options.workerId,
          outboxMessageId: message.id,
          topic: message.topic,
          failureCode: sanitizeFailure(cause).code,
        });
      });
  };
  const timer = setInterval(heartbeat, options.heartbeatIntervalMs);
  try {
    await operation();
  } finally {
    clearInterval(timer);
    await heartbeatChain;
  }
}

async function persistFailure(
  options: DispatchOutboxOptions,
  message: OutboxMessage,
  failure: SanitizedFailure,
): Promise<void> {
  const attemptedAt = options.now();
  const exception =
    !failure.retryable || message.attempts >= options.maxAttempts;
  const persisted = exception
    ? await options.store.except({
        messageId: message.id,
        workerId: options.workerId,
        attemptedAt,
        exceptionAt: attemptedAt,
        failureCode: failure.code,
      })
    : await options.store.retry({
        messageId: message.id,
        workerId: options.workerId,
        attemptedAt,
        nextAttemptAt: new Date(
          attemptedAt.getTime() +
            retryDelayMs(message.attempts, options.retryBaseDelayMs),
        ),
        failureCode: failure.code,
      });

  if (!persisted) {
    logClaimLost(options, message);
    return;
  }
  options.logger.error({
    event: "outbox.dispatch_failed",
    workerId: options.workerId,
    outboxMessageId: message.id,
    topic: message.topic,
    attempt: message.attempts,
    failureCode: failure.code,
    outcome: exception ? "EXCEPTION" : "RETRY_SCHEDULED",
  });
}

function retryDelayMs(attempt: number, baseDelayMs: number): number {
  return baseDelayMs * 2 ** Math.max(0, attempt - 1);
}

export function sanitizeFailure(cause: unknown): SanitizedFailure {
  if (typeof cause !== "object" || cause === null) {
    return { code: "UNEXPECTED_FAILURE", retryable: true };
  }
  const candidate = cause as { code?: unknown; retryable?: unknown };
  const code =
    typeof candidate.code === "string" &&
    failureCodePattern.test(candidate.code)
      ? candidate.code
      : "UNEXPECTED_FAILURE";
  return {
    code,
    retryable:
      typeof candidate.retryable === "boolean" ? candidate.retryable : true,
  };
}

function logClaimLost(
  options: DispatchOutboxOptions,
  message: OutboxMessage,
): void {
  options.logger.error({
    event: "outbox.claim_lost",
    workerId: options.workerId,
    outboxMessageId: message.id,
    topic: message.topic,
    attempt: message.attempts,
    failureCode: "OUTBOX_CLAIM_LOST",
  });
}

export function validateDispatchOutboxOptions(
  options: DispatchOutboxOptions,
): void {
  for (const [name, value] of [
    ["WORKER_CONCURRENCY_INVALID", options.concurrency],
    ["WORKER_MAX_ATTEMPTS_INVALID", options.maxAttempts],
    ["WORKER_RETRY_DELAY_INVALID", options.retryBaseDelayMs],
    ["WORKER_HEARTBEAT_INTERVAL_INVALID", options.heartbeatIntervalMs],
    ["WORKER_CLAIM_LEASE_INVALID", options.claimLeaseMs],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(name);
  }
  if (options.heartbeatIntervalMs >= options.claimLeaseMs) {
    throw new Error("WORKER_HEARTBEAT_MUST_PRECEDE_LEASE");
  }
  if (options.concurrency > 100) {
    throw new Error("WORKER_CONCURRENCY_INVALID");
  }
}
