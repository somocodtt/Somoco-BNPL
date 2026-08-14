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
    let nowMs = initialTime;
    const handler: OutboxHandler = async () => {
      throw new IntegrationTemporaryError("ERP_UNAVAILABLE");
    };

    await dispatch(database, "worker-one", () => new Date(nowMs), handler, 2);
    expect(await listOutboxAttempts(database, message.id)).toEqual([
      {
        attemptNumber: 1,
        workerId: "worker-one",
        attemptedAt: new Date(initialTime),
        outcome: "RETRY_SCHEDULED",
        failureCode: "ERP_UNAVAILABLE",
        nextAttemptAt: new Date(initialTime + 1_000),
      },
    ]);

    await close();
    ({ db: database, close } = createDatabase(databaseUrl));
    nowMs += 999;
    expect(
      await dispatch(database, "worker-two", () => new Date(nowMs), handler, 2),
    ).toBe(0);

    nowMs += 1;
    expect(
      await dispatch(database, "worker-two", () => new Date(nowMs), handler, 2),
    ).toBe(1);
    expect(await listOutboxAttempts(database, message.id)).toEqual([
      {
        attemptNumber: 1,
        workerId: "worker-one",
        attemptedAt: new Date(initialTime),
        outcome: "RETRY_SCHEDULED",
        failureCode: "ERP_UNAVAILABLE",
        nextAttemptAt: new Date(initialTime + 1_000),
      },
      {
        attemptNumber: 2,
        workerId: "worker-two",
        attemptedAt: new Date(initialTime + 1_000),
        outcome: "EXCEPTION",
        failureCode: "ERP_UNAVAILABLE",
        nextAttemptAt: null,
      },
    ]);
    nowMs += 60_000;
    expect(
      await dispatch(
        database,
        "worker-three",
        () => new Date(nowMs),
        handler,
        2,
      ),
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
    expect(await listOutboxAttempts(database, message.id)).toEqual([
      {
        attemptNumber: 1,
        workerId: "worker-one",
        attemptedAt: new Date(initialTime),
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
      claimedAt: new Date(initialTime),
      staleBefore: new Date(initialTime - 1),
    });
    expect(first?.id).toBe(message.id);
    expect(
      await store.heartbeat({
        messageId: message.id,
        workerId: "worker-one",
        heartbeatAt: new Date(initialTime + 1_000),
      }),
    ).toBe(true);

    expect(
      await store.claim({
        workerId: "worker-two",
        limit: 1,
        claimedAt: new Date(initialTime + 1_500),
        staleBefore: new Date(initialTime + 900),
      }),
    ).toEqual([]);
    expect(
      await store.claim({
        workerId: "worker-two",
        limit: 1,
        claimedAt: new Date(initialTime + 2_001),
        staleBefore: new Date(initialTime + 1_001),
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
        claimedAt: new Date(initialTime),
        staleBefore: new Date(initialTime - 1),
      });

    const [workerOne, workerTwo] = await Promise.all([
      claim("worker-one"),
      claim("worker-two"),
    ]);

    expect(workerOne).toHaveLength(1);
    expect(workerTwo).toHaveLength(1);
    expect(workerOne[0]?.id).not.toBe(workerTwo[0]?.id);
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
    retryBaseDelayMs: 1_000,
    heartbeatIntervalMs: 10_000,
    claimLeaseMs: 30_000,
    now,
    logger: { info() {}, error() {} },
  });
}
