import { randomUUID } from "node:crypto";
import {
  createDatabase,
  enqueueOutbox,
  listOutboxAttempts,
  migrateDatabase,
  type Database,
  type OutboxMessage,
} from "@somo/db";
import { IntegrationTemporaryError } from "@somo/integrations";
import { resetTestDatabase } from "@somo/testkit";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabaseOutboxStore } from "../src/database-outbox-store.js";
import {
  dispatchOutboxBatch,
  type OutboxHandler,
  type OutboxClaimStore,
} from "../src/jobs/dispatch-outbox.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required for worker integration tests");
}

const initialTime = Date.parse("2026-08-14T12:00:00.000Z");
const aggregateId = "00000000-0000-4000-8000-000000000100";

describe("PostgreSQL-backed outbox worker", () => {
  let database: Database;
  let close: () => Promise<void>;

  beforeAll(() => {
    ({ db: database, close } = createDatabase(databaseUrl));
  });

  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(database);
  });

  afterAll(async () => {
    await close();
  });

  it("persists retry visibility and final exception across a database restart", async () => {
    const message = await enqueue(database);
    const handler: OutboxHandler = async () => {
      throw new IntegrationTemporaryError("ERP_UNAVAILABLE");
    };

    await dispatch(database, "worker-one", () => new Date(), handler, 2);
    expect(await listOutboxAttempts(database, message.id)).toMatchObject([
      {
        attemptNumber: 1,
        workerId: "worker-one",
        attemptedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        outcome: "RETRY_SCHEDULED",
        failureCode: "ERP_UNAVAILABLE",
        nextAttemptAt: expect.any(Date),
      },
    ]);

    await close();
    ({ db: database, close } = createDatabase(databaseUrl));
    expect(
      await dispatch(database, "worker-two", () => new Date(), handler, 2),
    ).toBe(0);

    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(
      await dispatch(database, "worker-two", () => new Date(), handler, 2),
    ).toBe(1);
    expect(await listOutboxAttempts(database, message.id)).toMatchObject([
      {
        attemptNumber: 1,
        workerId: "worker-one",
        attemptedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        outcome: "RETRY_SCHEDULED",
        failureCode: "ERP_UNAVAILABLE",
        nextAttemptAt: expect.any(Date),
      },
      {
        attemptNumber: 2,
        workerId: "worker-two",
        attemptedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        outcome: "EXCEPTION",
        failureCode: "ERP_UNAVAILABLE",
        nextAttemptAt: null,
      },
    ]);
    expect(
      await dispatch(database, "worker-three", () => new Date(), handler, 2),
    ).toBe(0);
  });

  it("persists completion and does not publish the same row twice", async () => {
    const message = await enqueue(database);
    const handled: string[] = [];

    expect(
      await dispatch(
        database,
        "worker-one",
        () => new Date(initialTime),
        async (claimed) => {
          handled.push(claimed.id);
        },
      ),
    ).toBe(1);
    expect(
      await dispatch(
        database,
        "worker-two",
        () => new Date(initialTime + 60_000),
        async () => undefined,
      ),
    ).toBe(0);
    expect(handled).toEqual([message.id]);
    expect(await listOutboxAttempts(database, message.id)).toMatchObject([
      {
        attemptNumber: 1,
        workerId: "worker-one",
        attemptedAt: expect.any(Date),
        finishedAt: expect.any(Date),
        outcome: "PUBLISHED",
        failureCode: null,
        nextAttemptAt: null,
      },
    ]);
  });

  it("uses heartbeats to keep an active lease from being reclaimed", async () => {
    const message = await enqueue(database);
    const store = createDatabaseOutboxStore(database);
    const [first] = await store.claim({
      workerId: "worker-one",
      limit: 1,
      claimLeaseMs: 100,
      maxAttempts: 3,
    });
    expect(first?.id).toBe(message.id);
    expect(
      await store.heartbeat({
        messageId: message.id,
        workerId: "worker-one",
        leaseToken: first?.leaseToken ?? "missing",
      }),
    ).toBe(true);

    expect(
      await store.claim({
        workerId: "worker-two",
        limit: 1,
        claimLeaseMs: 100,
        maxAttempts: 3,
      }),
    ).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 110));
    expect(
      await store.claim({
        workerId: "worker-two",
        limit: 1,
        claimLeaseMs: 100,
        maxAttempts: 3,
      }),
    ).toMatchObject([{ id: message.id, attempts: 2 }]);
  });

  it("gives concurrent PostgreSQL workers distinct claims", async () => {
    await Promise.all([enqueue(database), enqueue(database)]);
    const store = createDatabaseOutboxStore(database);
    const claim = (workerId: string) =>
      store.claim({
        workerId,
        limit: 1,
        claimLeaseMs: 30_000,
        maxAttempts: 3,
      });

    const [workerOne, workerTwo] = await Promise.all([
      claim("worker-one"),
      claim("worker-two"),
    ]);

    expect(workerOne).toHaveLength(1);
    expect(workerTwo).toHaveLength(1);
    expect(workerOne[0]?.id).not.toBe(workerTwo[0]?.id);
  });

  it("denies a stale claimant with the same worker id after lease reclaim", async () => {
    const message = await enqueue(database);
    const store = createDatabaseOutboxStore(database);
    const [first] = await store.claim({
      workerId: "reused-worker",
      limit: 1,
      claimLeaseMs: 5,
      maxAttempts: 3,
    });
    expect(first?.leaseToken).toEqual(expect.any(String));

    await new Promise((resolve) => setTimeout(resolve, 15));
    const [reclaimed] = await store.claim({
      workerId: "reused-worker",
      limit: 1,
      claimLeaseMs: 5,
      maxAttempts: 3,
    });
    expect(reclaimed).toMatchObject({ id: message.id, attempts: 2 });
    expect(reclaimed?.leaseToken).not.toBe(first?.leaseToken);

    const staleOwnership = {
      messageId: message.id,
      workerId: "reused-worker",
      leaseToken: first?.leaseToken ?? "missing",
    };
    expect(await store.heartbeat(staleOwnership)).toBe(false);
    expect(await store.complete(staleOwnership)).toBe(false);
    expect(
      await store.retry({
        ...staleOwnership,
        failureCode: "ERP_UNAVAILABLE",
        retryDelayMs: 1,
      }),
    ).toBe(false);
    expect(
      await store.except({
        ...staleOwnership,
        failureCode: "ERP_UNAVAILABLE",
      }),
    ).toBe(false);
    expect(
      await store.complete({
        messageId: message.id,
        workerId: "reused-worker",
        leaseToken: reclaimed?.leaseToken ?? "missing",
      }),
    ).toBe(true);
  });

  it("records crash-abandoned attempts and never claims beyond max attempts", async () => {
    const message = await enqueue(database);
    const firstStore = createDatabaseOutboxStore(database);
    const [first] = await firstStore.claim({
      workerId: "worker-one",
      limit: 1,
      claimLeaseMs: 5,
      maxAttempts: 2,
    });
    expect(first).toMatchObject({ id: message.id, attempts: 1 });
    let providerCalls = 1;

    await close();
    ({ db: database, close } = createDatabase(databaseUrl));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const secondStore = createDatabaseOutboxStore(database);
    const [second] = await secondStore.claim({
      workerId: "worker-two",
      limit: 1,
      claimLeaseMs: 5,
      maxAttempts: 2,
    });
    expect(second).toMatchObject({ id: message.id, attempts: 2 });
    providerCalls += 1;

    await close();
    ({ db: database, close } = createDatabase(databaseUrl));
    await new Promise((resolve) => setTimeout(resolve, 15));
    const thirdStore = createDatabaseOutboxStore(database);
    expect(
      await thirdStore.claim({
        workerId: "worker-three",
        limit: 1,
        claimLeaseMs: 5,
        maxAttempts: 2,
      }),
    ).toEqual([]);
    expect(providerCalls).toBe(2);
    expect(await listOutboxAttempts(database, message.id)).toMatchObject([
      {
        attemptNumber: 1,
        workerId: "worker-one",
        outcome: "ABANDONED",
        failureCode: "OUTBOX_CLAIM_EXPIRED",
      },
      {
        attemptNumber: 2,
        workerId: "worker-two",
        outcome: "EXCEPTION",
        failureCode: "OUTBOX_MAX_ATTEMPTS_REACHED",
      },
    ]);
  });
});

async function enqueue(database: Database): Promise<OutboxMessage> {
  return enqueueOutbox(database, {
    id: randomUUID(),
    topic: "erp.publish",
    aggregateType: "contract",
    aggregateId,
    payload: { amountMinorUnits: "12500" },
    occurredAt: new Date(initialTime),
  });
}

function dispatch(
  database: Database,
  workerId: string,
  now: () => Date,
  handler: OutboxHandler,
  maxAttempts = 3,
): Promise<number> {
  const store: OutboxClaimStore = createDatabaseOutboxStore(database);
  return dispatchOutboxBatch({
    store,
    workerId,
    handlers: new Map([["erp.publish", handler]]),
    concurrency: 1,
    maxAttempts,
    retryBaseDelayMs: 500,
    heartbeatIntervalMs: 10_000,
    claimLeaseMs: 30_000,
    now,
    logger: { info() {}, error() {} },
  });
}
