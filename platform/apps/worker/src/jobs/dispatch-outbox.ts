import type { ClaimedOutboxMessage, OutboxMessage } from "@somo/db";
import {
  hasProductionAdapterCapability,
  isSimulatorAdapter,
  type OtpDeliveryPolicyBinding,
  type GuarantorInvitationDeliveryPolicyBinding,
  type ProductionAdapterCapability,
} from "@somo/integrations";

const failureCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/;

export type WorkerLogRecord = Readonly<Record<string, unknown>>;

export interface WorkerLogger {
  info(record: WorkerLogRecord): void;
  error(record: WorkerLogRecord): void;
}

export interface ClaimOutboxOptions {
  workerId: string;
  limit: number;
  claimLeaseMs: number;
  maxAttempts: number;
}

export interface HeartbeatOutboxClaim {
  messageId: string;
  workerId: string;
  leaseToken: string;
}

export interface CompleteOutboxAttempt {
  messageId: string;
  workerId: string;
  leaseToken: string;
}

export interface FailOutboxAttempt {
  messageId: string;
  workerId: string;
  leaseToken: string;
  failureCode: string;
}

export interface OutboxClaimStore {
  claim(options: ClaimOutboxOptions): Promise<ClaimedOutboxMessage[]>;
  heartbeat(input: HeartbeatOutboxClaim): Promise<boolean>;
  complete(input: CompleteOutboxAttempt): Promise<boolean>;
  retry(input: FailOutboxAttempt & { retryDelayMs: number }): Promise<boolean>;
  except(input: FailOutboxAttempt): Promise<boolean>;
}

export type OutboxHandler = (message: OutboxMessage) => Promise<unknown>;

type HandlerProvenance = "UNDECLARED" | "PRODUCTION" | "SIMULATOR";
interface HandlerRegistration {
  provenance: HandlerProvenance;
  capabilities: ReadonlySet<ProductionAdapterCapability>;
  otpDeliveryPolicy?: Readonly<OtpDeliveryPolicyBinding>;
  guarantorInvitationDeliveryPolicy?: Readonly<GuarantorInvitationDeliveryPolicyBinding>;
}
const handlerRegistrations = new WeakMap<OutboxHandler, HandlerRegistration>();

export function createOutboxHandler(
  adapters: readonly object[],
  handler: OutboxHandler,
  requiredCapabilities: readonly (readonly [
    object,
    ProductionAdapterCapability,
  ])[] = [],
  metadata?: {
    otpDeliveryPolicy?: Readonly<OtpDeliveryPolicyBinding>;
    guarantorInvitationDeliveryPolicy?: Readonly<GuarantorInvitationDeliveryPolicyBinding>;
  },
): OutboxHandler {
  const registered: OutboxHandler = (message) => handler(message);
  const provenance: HandlerProvenance = adapters.some((adapter) =>
    isSimulatorAdapter(adapter),
  )
    ? "SIMULATOR"
    : requiredCapabilities.every(([adapter, capability]) =>
          hasProductionAdapterCapability(adapter, capability),
        )
      ? "PRODUCTION"
      : "UNDECLARED";
  const capabilities = new Set(
    requiredCapabilities
      .filter(([adapter, capability]) =>
        hasProductionAdapterCapability(adapter, capability),
      )
      .map(([, capability]) => capability),
  );
  handlerRegistrations.set(registered, {
    provenance,
    capabilities,
    ...(metadata?.otpDeliveryPolicy === undefined
      ? {}
      : { otpDeliveryPolicy: metadata.otpDeliveryPolicy }),
    ...(metadata?.guarantorInvitationDeliveryPolicy === undefined
      ? {}
      : {
          guarantorInvitationDeliveryPolicy:
            metadata.guarantorInvitationDeliveryPolicy,
        }),
  });
  return registered;
}

export function inspectOutboxHandlerProvenance(
  handler: OutboxHandler,
): "UNDECLARED" | "PRODUCTION" | "SIMULATOR" {
  return handlerRegistrations.get(handler)?.provenance ?? "UNDECLARED";
}

export function inspectOutboxHandlerRegistration(
  handler: OutboxHandler,
): Readonly<HandlerRegistration> | null {
  return handlerRegistrations.get(handler) ?? null;
}

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
  const messages = await options.store.claim({
    workerId: options.workerId,
    limit: options.concurrency,
    claimLeaseMs: options.claimLeaseMs,
    maxAttempts: options.maxAttempts,
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
  message: ClaimedOutboxMessage,
): Promise<void> {
  const handler = options.handlers.get(message.topic);
  try {
    if (message.attempts > options.maxAttempts) {
      const persisted = await options.store.except({
        messageId: message.id,
        workerId: options.workerId,
        leaseToken: message.leaseToken,
        failureCode: "OUTBOX_MAX_ATTEMPTS_REACHED",
      });
      if (!persisted) {
        logClaimLost(options, message);
      } else {
        options.logger.error({
          event: "outbox.dispatch_failed",
          workerId: options.workerId,
          outboxMessageId: message.id,
          topic: message.topic,
          attempt: message.attempts,
          failureCode: "OUTBOX_MAX_ATTEMPTS_REACHED",
          outcome: "EXCEPTION",
        });
      }
      return;
    }
    if (handler === undefined) {
      throw new PermanentWorkerError("OUTBOX_HANDLER_NOT_FOUND");
    }
    await runWithHeartbeat(options, message, () =>
      handler(toHandlerMessage(message)),
    );
    const persisted = await options.store.complete({
      messageId: message.id,
      workerId: options.workerId,
      leaseToken: message.leaseToken,
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

function toHandlerMessage(message: ClaimedOutboxMessage): OutboxMessage {
  return {
    id: message.id,
    topic: message.topic,
    aggregateType: message.aggregateType,
    aggregateId: message.aggregateId,
    payload: message.payload,
    occurredAt: message.occurredAt,
    attempts: message.attempts,
  };
}

async function runWithHeartbeat(
  options: DispatchOutboxOptions,
  message: ClaimedOutboxMessage,
  operation: () => Promise<unknown>,
): Promise<void> {
  let heartbeatChain = Promise.resolve();
  const heartbeat = () => {
    heartbeatChain = heartbeatChain
      .then(async () => {
        const persisted = await options.store.heartbeat({
          messageId: message.id,
          workerId: options.workerId,
          leaseToken: message.leaseToken,
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
  message: ClaimedOutboxMessage,
  failure: SanitizedFailure,
): Promise<void> {
  const exception =
    !failure.retryable || message.attempts >= options.maxAttempts;
  const persisted = exception
    ? await options.store.except({
        messageId: message.id,
        workerId: options.workerId,
        leaseToken: message.leaseToken,
        failureCode: failure.code,
      })
    : await options.store.retry({
        messageId: message.id,
        workerId: options.workerId,
        leaseToken: message.leaseToken,
        retryDelayMs: retryDelayMs(message.attempts, options.retryBaseDelayMs),
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
  message: ClaimedOutboxMessage,
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
