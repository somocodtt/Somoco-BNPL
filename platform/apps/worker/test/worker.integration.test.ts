import { describe, expect, it } from "vitest";
import type { ClaimedOutboxMessage, OutboxMessage } from "@somo/db";
import { deriveOtpCode } from "@somo/integrations";
import {
  IntegrationTemporaryError,
  createPaymentWebhookSimulator,
  createSmsSimulator,
} from "@somo/integrations/simulators";
import {
  readWorkerProcessConfig,
  startWorker,
  validateWorkerHandlerRegistry,
} from "../src/main.js";
import {
  createOutboxHandler,
  dispatchOutboxBatch,
  type ClaimOutboxOptions,
  type CompleteOutboxAttempt,
  type FailOutboxAttempt,
  type HeartbeatOutboxClaim,
  type OutboxClaimStore,
  type OutboxHandler,
} from "../src/jobs/dispatch-outbox.js";
import { createRecomputeArrearsHandler } from "../src/jobs/recompute-arrears.js";
import {
  createSendNotificationHandler,
  createSendOtpHandler,
} from "../src/jobs/send-notification.js";

type StoredState = "PENDING" | "CLAIMED" | "PUBLISHED" | "EXCEPTION";

interface StoredMessage {
  message: OutboxMessage;
  state: StoredState;
  availableAt: Date;
  claimedBy?: string;
  leaseToken?: string;
  heartbeatAt?: Date;
  publishedAt?: Date;
  exceptionAt?: Date;
  failureCode?: string;
  attemptedAt: Date[];
}

class DurableTestOutbox implements OutboxClaimStore {
  readonly records: StoredMessage[];
  heartbeatCount = 0;
  now = () => new Date();
  private tokenSequence = 0;

  constructor(messages: readonly OutboxMessage[]) {
    this.records = messages.map((message) => ({
      message: { ...message },
      state: "PENDING",
      availableAt: new Date(0),
      attemptedAt: [],
    }));
  }

  async claim(options: ClaimOutboxOptions): Promise<ClaimedOutboxMessage[]> {
    const claimedAt = this.now();
    const staleBefore = new Date(claimedAt.getTime() - options.claimLeaseMs);
    const claimed = this.records
      .filter(
        (record) =>
          (record.state === "PENDING" &&
            record.availableAt <= claimedAt &&
            record.message.attempts < options.maxAttempts) ||
          (record.state === "CLAIMED" &&
            record.heartbeatAt !== undefined &&
            record.heartbeatAt < staleBefore &&
            record.message.attempts < options.maxAttempts),
      )
      .slice(0, options.limit);

    return claimed.map((record) => {
      record.state = "CLAIMED";
      record.claimedBy = options.workerId;
      record.leaseToken = `lease-${String(++this.tokenSequence)}`;
      record.heartbeatAt = claimedAt;
      record.message = {
        ...record.message,
        attempts: record.message.attempts + 1,
      };
      return { ...record.message, leaseToken: record.leaseToken };
    });
  }

  async heartbeat(input: HeartbeatOutboxClaim): Promise<boolean> {
    const record = this.owned(
      input.messageId,
      input.workerId,
      input.leaseToken,
    );
    if (record === undefined) return false;
    record.heartbeatAt = this.now();
    this.heartbeatCount += 1;
    return true;
  }

  async complete(input: CompleteOutboxAttempt): Promise<boolean> {
    const record = this.owned(
      input.messageId,
      input.workerId,
      input.leaseToken,
    );
    if (record === undefined) return false;
    record.state = "PUBLISHED";
    record.publishedAt = this.now();
    record.attemptedAt.push(this.now());
    delete record.claimedBy;
    delete record.leaseToken;
    return true;
  }

  async retry(
    input: FailOutboxAttempt & { retryDelayMs: number },
  ): Promise<boolean> {
    const record = this.owned(
      input.messageId,
      input.workerId,
      input.leaseToken,
    );
    if (record === undefined) return false;
    record.state = "PENDING";
    const attemptedAt = this.now();
    record.availableAt = new Date(attemptedAt.getTime() + input.retryDelayMs);
    record.failureCode = input.failureCode;
    record.attemptedAt.push(attemptedAt);
    delete record.claimedBy;
    delete record.leaseToken;
    return true;
  }

  async except(input: FailOutboxAttempt): Promise<boolean> {
    const record = this.owned(
      input.messageId,
      input.workerId,
      input.leaseToken,
    );
    if (record === undefined) return false;
    record.state = "EXCEPTION";
    record.exceptionAt = this.now();
    record.failureCode = input.failureCode;
    record.attemptedAt.push(this.now());
    delete record.claimedBy;
    delete record.leaseToken;
    return true;
  }

  private owned(
    messageId: string,
    workerId: string,
    leaseToken: string,
  ): StoredMessage | undefined {
    return this.records.find(
      (record) =>
        record.message.id === messageId &&
        record.state === "CLAIMED" &&
        record.claimedBy === workerId &&
        record.leaseToken === leaseToken,
    );
  }
}

const initialTime = Date.parse("2026-08-14T12:00:00.000Z");

function outboxMessage(id: string): OutboxMessage {
  return {
    id,
    topic: "erp.publish",
    aggregateType: "contract",
    aggregateId: "00000000-0000-4000-8000-000000000100",
    payload: { privateValue: "must-not-be-logged" },
    occurredAt: new Date(initialTime),
    attempts: 0,
  };
}

function dispatcher(input: {
  store: DurableTestOutbox;
  workerId?: string;
  now: () => Date;
  handler: OutboxHandler;
  concurrency?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
}) {
  input.store.now = input.now;
  return dispatchOutboxBatch({
    store: input.store,
    workerId: input.workerId ?? "worker-one",
    handlers: new Map([["erp.publish", input.handler]]),
    concurrency: input.concurrency ?? 1,
    maxAttempts: input.maxAttempts ?? 3,
    retryBaseDelayMs: input.retryBaseDelayMs ?? 1_000,
    heartbeatIntervalMs: 10_000,
    claimLeaseMs: 30_000,
    now: input.now,
    logger: { info() {}, error() {} },
  });
}

async function eventually(
  condition: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) {
      throw new Error("TEST_CONDITION_TIMEOUT");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("durable outbox worker", () => {
  it("rejects simulator-backed handlers at the production bootstrap boundary", () => {
    const sms = createSmsSimulator({ environment: "test", fixtures: [] });
    const payment = createPaymentWebhookSimulator({
      environment: "test",
      fixtures: [],
    });
    const handlers = new Map<string, OutboxHandler>([
      ["notification.send", createSendNotificationHandler(sms)],
      ["payment.verify", createOutboxHandler([payment], async () => undefined)],
    ]);

    expect(() => validateWorkerHandlerRegistry("production", handlers)).toThrow(
      "WORKER_SIMULATOR_HANDLER_FORBIDDEN",
    );
  });

  it("rejects a wrapped simulator SMS handler in production", () => {
    const simulator = createSmsSimulator({ environment: "test", fixtures: [] });
    const wrapped = {
      send: (input: Parameters<typeof simulator.send>[0]) =>
        simulator.send(input),
    };
    const handler = createSendOtpHandler({
      sms: wrapped,
      lookup: {
        async find() {
          return null;
        },
      },
      derivationSecret: "test-otp-delivery-secret-with-at-least-32-characters",
      codeLength: 6,
    });

    expect(() =>
      validateWorkerHandlerRegistry(
        "production",
        new Map([["identity.otp_sms_requested", handler]]),
      ),
    ).toThrow("WORKER_HANDLER_PROVENANCE_REQUIRED");
  });

  it("accepts provenance-declared production adapters in production", () => {
    const productionPaymentVerifier = {
      async verify() {
        throw new Error("PROVIDER_NOT_CONFIGURED");
      },
    };
    const handlers = new Map<string, OutboxHandler>([
      [
        "payment.verify",
        createOutboxHandler([productionPaymentVerifier], async () => undefined),
      ],
    ]);

    expect(() =>
      validateWorkerHandlerRegistry("production", handlers),
    ).not.toThrow();
  });

  it("rejects undeclared handler provenance in production", () => {
    expect(() =>
      validateWorkerHandlerRegistry(
        "production",
        new Map([["opaque.handler", async () => undefined]]),
      ),
    ).toThrow("WORKER_HANDLER_PROVENANCE_REQUIRED");
  });

  it("cannot hide a simulator in an empty-adapter handler wrapper in production", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => {
        const sms = createSmsSimulator({ environment: "test", fixtures: [] });
        const hiddenSimulatorHandler = createOutboxHandler([], async () =>
          sms.send({
            idempotencyKey: "hidden-simulator",
            phoneE164: "+233201234567",
            template: "TEST",
            variables: {},
          }),
        );
        validateWorkerHandlerRegistry(
          "production",
          new Map([["notification.send", hiddenSimulatorHandler]]),
        );
      }).toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });

  it("fails closed when production bootstrap configuration is incomplete", () => {
    expect(() => readWorkerProcessConfig({})).toThrow(
      "WORKER_DATABASE_URL_REQUIRED",
    );
    expect(() =>
      readWorkerProcessConfig({ DATABASE_URL: "postgresql://database" }),
    ).toThrow("WORKER_ID_REQUIRED");
    expect(() =>
      readWorkerProcessConfig({
        DATABASE_URL: "postgresql://database",
        WORKER_ID: "worker-one",
      }),
    ).toThrow("WORKER_HANDLERS_MODULE_REQUIRED");
    expect(
      readWorkerProcessConfig({
        DATABASE_URL: "postgresql://database",
        WORKER_ID: "worker-one",
        WORKER_HANDLERS_MODULE: "file:///deployment/worker-handlers.js",
        NODE_ENV: "production",
      }),
    ).toEqual({
      databaseUrl: "postgresql://database",
      workerId: "worker-one",
      handlersModule: "file:///deployment/worker-handlers.js",
      environment: "production",
    });
    expect(() =>
      readWorkerProcessConfig({
        DATABASE_URL: "postgresql://database",
        WORKER_ID: "worker-one",
        WORKER_HANDLERS_MODULE: "file:///deployment/worker-handlers.js",
        NODE_ENV: "prodution",
      }),
    ).toThrow("WORKER_NODE_ENV_INVALID");
    expect(() =>
      readWorkerProcessConfig({
        DATABASE_URL: "postgresql://database",
        WORKER_ID: "worker-one",
        WORKER_HANDLERS_MODULE: "file:///deployment/worker-handlers.js",
      }),
    ).toThrow("WORKER_NODE_ENV_REQUIRED");
  });

  it("does not invoke a handler for a claim beyond max attempts", async () => {
    let handlerCalls = 0;
    let exceptionCalls = 0;
    const claim = {
      ...outboxMessage("over-limit-message"),
      attempts: 3,
      leaseToken: "opaque-lease",
    };
    const store: OutboxClaimStore = {
      async claim() {
        return [claim];
      },
      async heartbeat() {
        return true;
      },
      async complete() {
        return true;
      },
      async retry() {
        return true;
      },
      async except(input) {
        exceptionCalls += 1;
        expect(input).toMatchObject({
          leaseToken: "opaque-lease",
          failureCode: "OUTBOX_MAX_ATTEMPTS_REACHED",
        });
        return true;
      },
    };

    await dispatchOutboxBatch({
      store,
      workerId: "worker-one",
      handlers: new Map([
        [
          "erp.publish",
          async () => {
            handlerCalls += 1;
          },
        ],
      ]),
      concurrency: 1,
      maxAttempts: 2,
      retryBaseDelayMs: 1_000,
      heartbeatIntervalMs: 10_000,
      claimLeaseMs: 30_000,
      now: () => new Date(initialTime),
      logger: { info() {}, error() {} },
    });

    expect(handlerCalls).toBe(0);
    expect(exceptionCalls).toBe(1);
  });

  it("rejects invalid configuration before entering the worker loop", () => {
    const store = new DurableTestOutbox([]);

    expect(() =>
      startWorker({
        store,
        workerId: "worker-one",
        handlers: new Map(),
        concurrency: 101,
        logger: { info() {}, error() {} },
      }),
    ).toThrow("WORKER_CONCURRENCY_INVALID");
  });

  it("marks a successfully dispatched message as published", async () => {
    const store = new DurableTestOutbox([outboxMessage("message-1")]);
    const handled: string[] = [];
    let handlerSawLeaseToken = false;

    await dispatcher({
      store,
      now: () => new Date(initialTime),
      handler: async (message) => {
        handled.push(message.id);
        handlerSawLeaseToken = "leaseToken" in message;
      },
    });

    expect(handled).toEqual(["message-1"]);
    expect(handlerSawLeaseToken).toBe(false);
    expect(store.records[0]).toMatchObject({
      state: "PUBLISHED",
      attemptedAt: [new Date(initialTime)],
    });
    expect(store.records[0]?.failureCode).toBeUndefined();
  });

  it("persists exponential retry times for temporary failures", async () => {
    const store = new DurableTestOutbox([outboxMessage("message-1")]);
    let nowMs = initialTime;
    const now = () => new Date(nowMs);
    const handler: OutboxHandler = async () => {
      throw new IntegrationTemporaryError("ERP_UNAVAILABLE");
    };

    await dispatcher({ store, now, handler });
    expect(store.records[0]).toMatchObject({
      state: "PENDING",
      availableAt: new Date(initialTime + 1_000),
      failureCode: "ERP_UNAVAILABLE",
    });

    nowMs += 999;
    expect(await dispatcher({ store, now, handler })).toBe(0);
    nowMs += 1;
    await dispatcher({ store, now, handler });
    expect(store.records[0]).toMatchObject({
      state: "PENDING",
      availableAt: new Date(initialTime + 3_000),
      attemptedAt: [new Date(initialTime), new Date(initialTime + 1_000)],
    });
  });

  it("moves a message to exception state at the maximum attempt", async () => {
    const store = new DurableTestOutbox([outboxMessage("message-1")]);
    let nowMs = initialTime;
    const now = () => new Date(nowMs);
    const handler: OutboxHandler = async () => {
      throw new IntegrationTemporaryError("ERP_UNAVAILABLE");
    };

    for (const delay of [0, 1_000, 2_000]) {
      nowMs += delay;
      await dispatcher({ store, now, handler, maxAttempts: 3 });
    }

    expect(store.records[0]).toMatchObject({
      state: "EXCEPTION",
      exceptionAt: new Date(initialTime + 3_000),
      failureCode: "ERP_UNAVAILABLE",
      attemptedAt: [
        new Date(initialTime),
        new Date(initialTime + 1_000),
        new Date(initialTime + 3_000),
      ],
    });
  });

  it("lets concurrent workers claim distinct rows", async () => {
    const store = new DurableTestOutbox([
      outboxMessage("message-1"),
      outboxMessage("message-2"),
    ]);
    const handled = new Map<string, string>();
    const now = () => new Date(initialTime);

    await Promise.all([
      dispatcher({
        store,
        workerId: "worker-one",
        now,
        handler: async (message) => handled.set(message.id, "worker-one"),
      }),
      dispatcher({
        store,
        workerId: "worker-two",
        now,
        handler: async (message) => handled.set(message.id, "worker-two"),
      }),
    ]);

    expect([...handled.entries()].sort()).toEqual([
      ["message-1", "worker-one"],
      ["message-2", "worker-two"],
    ]);
    expect(store.records.map((record) => record.state)).toEqual([
      "PUBLISHED",
      "PUBLISHED",
    ]);
  });

  it("keeps long-running claims fresh with a heartbeat", async () => {
    const store = new DurableTestOutbox([outboxMessage("message-1")]);
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const options = {
      store,
      handlers: new Map<string, OutboxHandler>([
        ["erp.publish", async () => handlerGate],
      ]),
      concurrency: 1,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      heartbeatIntervalMs: 5,
      claimLeaseMs: 20,
      now: () => new Date(),
      logger: { info() {}, error() {} },
    } as const;

    const firstWorker = dispatchOutboxBatch({
      ...options,
      workerId: "worker-one",
    });
    await eventually(() => store.heartbeatCount > 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(
      await dispatchOutboxBatch({ ...options, workerId: "worker-two" }),
    ).toBe(0);

    releaseHandler?.();
    await firstWorker;
    expect(store.records[0]?.state).toBe("PUBLISHED");
  });

  it("never executes more handlers than the configured concurrency", async () => {
    const store = new DurableTestOutbox(
      Array.from({ length: 5 }, (_, index) =>
        outboxMessage(`message-${String(index + 1)}`),
      ),
    );
    let active = 0;
    let maximumActive = 0;
    const handler: OutboxHandler = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    };

    while (store.records.some((record) => record.state === "PENDING")) {
      await dispatcher({
        store,
        now: () => new Date(initialTime),
        handler,
        concurrency: 2,
      });
    }

    expect(maximumActive).toBe(2);
    expect(store.records.every((record) => record.state === "PUBLISHED")).toBe(
      true,
    );
  });

  it("logs structured failure metadata without payloads or exception messages", async () => {
    const store = new DurableTestOutbox([outboxMessage("message-1")]);
    const records: Record<string, unknown>[] = [];

    await dispatchOutboxBatch({
      store,
      workerId: "worker-one",
      handlers: new Map([
        [
          "erp.publish",
          async () => {
            throw new Error("customer phone +233201234567 secret-token");
          },
        ],
      ]),
      concurrency: 1,
      maxAttempts: 1,
      retryBaseDelayMs: 1_000,
      heartbeatIntervalMs: 10_000,
      claimLeaseMs: 30_000,
      now: () => new Date(initialTime),
      logger: {
        info(record) {
          records.push(record);
        },
        error(record) {
          records.push(record);
        },
      },
    });

    expect(store.records[0]).toMatchObject({
      state: "EXCEPTION",
      failureCode: "UNEXPECTED_FAILURE",
    });
    expect(records).toContainEqual({
      event: "outbox.dispatch_failed",
      workerId: "worker-one",
      outboxMessageId: "message-1",
      topic: "erp.publish",
      attempt: 1,
      failureCode: "UNEXPECTED_FAILURE",
      outcome: "EXCEPTION",
    });
    expect(JSON.stringify(records)).not.toContain("+233201234567");
    expect(JSON.stringify(records)).not.toContain("privateValue");
    expect(JSON.stringify(records)).not.toContain("secret-token");
  });

  it("drains an active handler and stops before claiming more work", async () => {
    const store = new DurableTestOutbox([
      outboxMessage("message-1"),
      outboxMessage("message-2"),
    ]);
    let releaseHandler: (() => void) | undefined;
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    const lifecycleEvents: string[] = [];
    const worker = startWorker({
      store,
      workerId: "worker-one",
      handlers: new Map([["erp.publish", async () => handlerGate]]),
      concurrency: 1,
      maxAttempts: 3,
      retryBaseDelayMs: 1_000,
      heartbeatIntervalMs: 5,
      claimLeaseMs: 30_000,
      pollIntervalMs: 5,
      logger: {
        info(record) {
          lifecycleEvents.push(String(record.event));
        },
        error() {},
      },
    });
    await eventually(() => store.records[0]?.state === "CLAIMED");

    let stopped = false;
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(stopped).toBe(false);

    releaseHandler?.();
    await stopping;

    expect(store.records.map((record) => record.state)).toEqual([
      "PUBLISHED",
      "PENDING",
    ]);
    expect(lifecycleEvents).toEqual([
      "worker.started",
      "outbox.claimed",
      "outbox.dispatched",
      "worker.stopped",
    ]);
  });

  it("uses the outbox id as the SMS provider idempotency key", async () => {
    const message = {
      ...outboxMessage("notification-1001"),
      topic: "notification.send",
      payload: {
        phoneE164: "+233201234567",
        template: "PAYMENT_RECEIPT",
        variables: { amount: "GHS 125.00" },
      },
    };
    const sms = createSmsSimulator({
      environment: "test",
      fixtures: [
        {
          input: {
            idempotencyKey: "notification-1001",
            phoneE164: "+233201234567",
            template: "PAYMENT_RECEIPT",
            variables: { amount: "GHS 125.00" },
          },
          result: {
            providerReference: "sms-sim-1001",
            acceptedAt: "2026-08-14T12:00:00.000Z",
          },
        },
      ],
    });
    const handler = createSendNotificationHandler(sms);

    const first = await handler(message);
    const duplicate = await handler(message);

    expect(duplicate).toEqual(first);
    expect(first).toEqual({
      providerReference: "sms-sim-1001",
      acceptedAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("derives a stable OTP only at dispatch and uses the outbox idempotency key", async () => {
    const derivationSecret =
      "test-otp-delivery-secret-with-at-least-32-characters";
    const challengeId = "00000000-0000-4000-8000-000000001001";
    const code = deriveOtpCode(derivationSecret, challengeId, 6);
    const message = {
      ...outboxMessage(challengeId),
      topic: "identity.otp_sms_requested",
      payload: {
        requestId: "request-1001",
        challengeId,
      },
    };
    const sms = createSmsSimulator({
      environment: "test",
      fixtures: [
        {
          input: {
            idempotencyKey: challengeId,
            phoneE164: "+233201234567",
            template: "CUSTOMER_AUTHENTICATION_OTP",
            variables: { code },
          },
          result: {
            providerReference: "sms-sim-otp-1001",
            acceptedAt: "2026-08-14T12:00:00.000Z",
          },
        },
      ],
    });
    const handler = createSendOtpHandler({
      sms,
      lookup: {
        async find() {
          return {
            phoneE164: "+233201234567",
            expiresAt: new Date("2026-08-14T12:02:00.000Z"),
            invalidatedAt: null,
            deliveryFailedAt: null,
          };
        },
      },
      derivationSecret,
      codeLength: 6,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    });

    const result = await handler(message);
    const retry = await handler(message);

    expect(retry).toEqual(result);
    expect(JSON.stringify(message.payload)).not.toContain(code);
    expect(JSON.stringify(message.payload)).not.toContain("+233201234567");
    expect(result).toEqual({
      providerReference: "sms-sim-otp-1001",
      acceptedAt: "2026-08-14T12:00:00.000Z",
    });
  });

  it("gives arrears recomputation a stable idempotency key", async () => {
    const executions = new Map<string, { recalculatedAt: string }>();
    const handler = createRecomputeArrearsHandler({
      async recompute(input) {
        const prior = executions.get(input.idempotencyKey);
        if (prior !== undefined) return prior;
        const result = { recalculatedAt: "2026-08-14T12:00:00.000Z" };
        executions.set(input.idempotencyKey, result);
        return result;
      },
    });
    const message = {
      ...outboxMessage("arrears-1001"),
      topic: "arrears.recompute",
      aggregateId: "00000000-0000-4000-8000-000000000200",
      payload: { asOfDate: "2026-08-14" },
    };

    const first = await handler(message);
    const duplicate = await handler(message);

    expect(duplicate).toEqual(first);
    expect(executions.size).toBe(1);
    expect(executions.has("arrears-1001")).toBe(true);
  });
});
