import { randomUUID } from "node:crypto";
import {
  createDatabase,
  enqueueOutbox,
  listOutboxAttempts,
} from "../../packages/db/src/index.js";
import type { CanonicalPaymentEvent } from "../../packages/integrations/src/index.js";
import { queryTestSql } from "../../packages/testkit/src/index.js";
import {
  createPaymentReconciliationJob,
  createReconcilePaymentsHandler,
} from "../../apps/worker/src/jobs/reconcile-payments.js";
import { createDatabaseOutboxStore } from "../../apps/worker/src/database-outbox-store.js";
import { dispatchOutboxBatch } from "../../apps/worker/src/jobs/dispatch-outbox.js";
import {
  startRealPilot,
  type PilotRuntime,
} from "../e2e/support/real-pilot.js";

const databaseUrl = "postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test";
const modeledMonthlyApplications = 5_200;
const sampleSize = 32;
const concurrency = 8;
const requestP95ThresholdMs = 1_000;

interface TimedResult {
  status: number;
  latencyMs: number;
}

async function main(): Promise<void> {
  process.env.TEST_DATABASE_URL = databaseUrl;
  let runtime: PilotRuntime | undefined;
  try {
    runtime = await startRealPilot();
    const events = Array.from({ length: sampleSize }, (_, index) =>
      paymentEvent(index + 1),
    );
    const startedAt = performance.now();
    const results: TimedResult[] = [];
    for (let offset = 0; offset < events.length; offset += concurrency) {
      const batch = events
        .slice(offset, offset + concurrency)
        .map((event) => postProviderEvent(runtime!, event));
      results.push(...(await Promise.all(batch)));
    }
    const elapsedMs = Math.max(1, performance.now() - startedAt);
    const sorted = results
      .map((item) => item.latencyMs)
      .sort((left, right) => left - right);
    const p95Index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
    const p95RequestLatencyMs = Number((sorted[p95Index] ?? 0).toFixed(2));
    const replay = await postProviderEvent(runtime, events[0]!);
    const providerResilience = await measureProviderResilience(runtime);
    const workerEvidence = await exerciseWorkerRestartAndReclaim(databaseUrl);
    const reconciliation = await queryTestSql<{ count: string }>(
      databaseUrl,
      "select count(*)::text as count from reconciliation_case",
    );
    const allAccepted =
      results.every((item) => item.status === 202) && replay.status === 202;
    const evidence = {
      mode: "SIMULATED_PROXY",
      persistence: "DISPOSABLE_POSTGRESQL",
      simulator: "SOMOCO_PAYMENTS_TEST_ADAPTER",
      modeledMonthlyApplications,
      sampleSize,
      concurrency,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      throughputPerSecond: Number(
        ((sampleSize / elapsedMs) * 1_000).toFixed(2),
      ),
      simulatedProxyP95RequestLatencyMs: p95RequestLatencyMs,
      requestStatusCodes: results.map((item) => item.status),
      replayStatus: replay.status,
      reconciliationCases: Number(reconciliation.count),
      thresholds: { simulatedProxyP95RequestLatencyMs: requestP95ThresholdMs },
      simulatedProxyPass:
        allAccepted &&
        p95RequestLatencyMs <= requestP95ThresholdMs &&
        providerResilience.pass &&
        workerEvidence.pass,
      concurrentWebhook: {
        requests: results.length,
        accepted: results.filter((item) => item.status === 202).length,
        pass: allAccepted,
      },
      providerResilience,
      workerRestartAndReclaim: workerEvidence,
      actualGates: {
        workerRestartAndReclaim: workerEvidence.pass
          ? "PASS_DISPOSABLE_POSTGRESQL"
          : "FAIL_DISPOSABLE_POSTGRESQL",
        queueAge: {
          status: "MEASURED_DISPOSABLE_POSTGRESQL",
          ageMs: workerEvidence.queueAgeMs,
        },
        providerResilience: providerResilience.pass
          ? "PASS_DISPOSABLE_SIMULATOR"
          : "FAIL_DISPOSABLE_SIMULATOR",
        hostingCapacity: "PENDING_EXTERNAL_REHEARSAL",
        restoreIntegrity: "PENDING_EXTERNAL_REHEARSAL",
        signedUat: "PENDING_EXTERNAL_SIGN_OFF",
      },
    } as const;
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (!evidence.simulatedProxyPass) process.exitCode = 1;
  } finally {
    await runtime?.close();
  }
}

async function measureProviderResilience(runtime: PilotRuntime): Promise<{
  outageStatus: number;
  recoveryStatus: number;
  pass: boolean;
}> {
  const event = paymentEvent(sampleSize + 1);
  runtime.controls.setPaymentAvailable(false);
  const outage = await postProviderEvent(runtime, event);
  runtime.controls.setPaymentAvailable(true);
  const recovery = await postProviderEvent(runtime, event);
  return {
    outageStatus: outage.status,
    recoveryStatus: recovery.status,
    pass: outage.status === 401 && recovery.status === 202,
  };
}

async function exerciseWorkerRestartAndReclaim(databaseUrl: string): Promise<{
  messageId: string;
  attemptOutcomes: string[];
  queueAgeMs: number;
  pass: boolean;
}> {
  const firstConnection = createDatabase(databaseUrl);
  const message = await enqueueOutbox(firstConnection.db, {
    id: randomUUID(),
    topic: "payments.reconcile",
    aggregateType: "settlement",
    aggregateId: randomUUID(),
    payload: { settlementReference: `CONTROLLED-PILOT-${randomUUID()}` },
    occurredAt: new Date("2026-07-31T12:00:00.000Z"),
  });
  const firstStore = createDatabaseOutboxStore(firstConnection.db);
  const [firstClaim] = await firstStore.claim({
    workerId: "controlled-pilot-worker-before-restart",
    limit: 1,
    claimLeaseMs: 25,
    maxAttempts: 3,
  });
  if (firstClaim?.id !== message.id) {
    await firstConnection.close();
    throw new Error("CONTROLLED_PILOT_OUTBOX_MARKER_NOT_CLAIMED");
  }
  const queueAgeMs = Math.max(0, Date.now() - message.occurredAt.getTime());
  await firstConnection.close();
  await new Promise((resolve) => setTimeout(resolve, 50));

  const secondConnection = createDatabase(databaseUrl);
  try {
    const feed = {
      async fetchPending() {
        return [
          {
            settlementReference: `CONTROLLED-PILOT-${message.id}`,
            provider: "SOMOCO_PAYMENTS" as const,
            providerTotalMinorUnits: 0n,
            receivedAt: new Date(),
          },
        ];
      },
    };
    const sink = {
      async compareSettlement() {
        return { status: "MATCHED" as const, varianceMinorUnits: "0" };
      },
    };
    const handler = createReconcilePaymentsHandler({
      job: createPaymentReconciliationJob({ feed, sink }),
    });
    const dispatched = await dispatchOutboxBatch({
      store: createDatabaseOutboxStore(secondConnection.db),
      workerId: "controlled-pilot-worker-after-restart",
      handlers: new Map([[message.topic, handler]]),
      concurrency: 1,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      heartbeatIntervalMs: 10,
      claimLeaseMs: 100,
      now: () => new Date(),
      logger: { info() {}, error() {} },
    });
    const attempts = await listOutboxAttempts(secondConnection.db, message.id);
    const attemptOutcomes = attempts.map((attempt) => attempt.outcome);
    return {
      messageId: message.id,
      attemptOutcomes,
      queueAgeMs,
      pass:
        dispatched === 1 && attemptOutcomes.join(",") === "ABANDONED,PUBLISHED",
    };
  } finally {
    await secondConnection.close();
  }
}

async function postProviderEvent(
  runtime: PilotRuntime,
  event: CanonicalPaymentEvent,
): Promise<TimedResult> {
  const rawBody = JSON.stringify(event);
  const signature = `controlled-pilot-${event.eventId}`;
  runtime.addPaymentFixture({
    rawBody: Uint8Array.from(Buffer.from(rawBody)),
    signature,
    requestTimestamp: event.occurredAt,
    event,
  });
  const startedAt = performance.now();
  const response = await fetch(
    `${runtime.baseUrl}/v1/integrations/payments/somoco`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-payment-signature": signature,
        "x-payment-timestamp": event.occurredAt,
      },
      body: rawBody,
    },
  );
  return { status: response.status, latencyMs: performance.now() - startedAt };
}

function paymentEvent(sequence: number): CanonicalPaymentEvent {
  const suffix = String(sequence).padStart(3, "0");
  return {
    eventId: `controlled-pilot-load-event-${suffix}`,
    eventType: "PAYMENT_SUCCEEDED",
    channel: "MOBILE_MONEY",
    providerTransactionId: `controlled-pilot-load-transaction-${suffix}`,
    payerPhoneE164: "+233241000001",
    customerReference: `CONTROLLED-PILOT-UNKNOWN-${suffix}`,
    amount: { currency: "GHS", minorUnits: "100" },
    occurredAt: "2026-08-01T12:20:00.000Z",
  };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
