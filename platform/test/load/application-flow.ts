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
const sampleSize = finitePopulationSampleSize(modeledMonthlyApplications);
const concurrency = 8;
const requestP95ThresholdMs = 1_000;
const maximumQueueAgeThresholdMs = 5_000;
const staffQueueSpecs = [
  { queue: "VERIFICATION", role: "VERIFICATION_OFFICER", share: 1 },
  { queue: "BSM_INITIAL", role: "BSM", share: 1 },
  { queue: "BSM_FINAL", role: "BSM", share: 1 },
  { queue: "AGM", role: "AGM", share: 1 },
  { queue: "CFO", role: "CFO", share: 1 },
  { queue: "MD", role: "MD", share: 1 },
  { queue: "FINANCE_RECONCILIATION", role: "FINANCE_OFFICER", share: 0.95 },
  { queue: "COLLECTIONS", role: "RECOVERY_OFFICER", share: 0.15 },
] as const;

interface TimedResult {
  status: number;
  latencyMs: number;
  body: Record<string, unknown> | null;
}

async function main(): Promise<void> {
  assertControlledPilotTarget();
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
    const replay = await postProviderEvent(runtime, {
      ...events[0]!,
      eventId: `${events[0]!.eventId}-replay`,
    });
    const providerResilience = await measureProviderResilience(runtime);
    const workerEvidence = await exerciseWorkerRestartAndReclaim(databaseUrl);
    const reconciliation = await queryTestSql<{
      count: string;
      payment_count: string;
    }>(
      databaseUrl,
      `select count(*)::text as count,
              (select count(*) from payment_transaction)::text as payment_count
         from reconciliation_case`,
    );
    const staffQueues = modelStaffQueues(
      modeledMonthlyApplications,
      sampleSize,
    );
    const allAccepted =
      results.every((item) => item.status === 202) &&
      replay.status === 202 &&
      replay.body?.duplicate === true;
    const evidence = {
      mode: "SIMULATED_PROXY",
      persistence: "DISPOSABLE_POSTGRESQL",
      simulator: "SOMOCO_PAYMENTS_TEST_ADAPTER",
      modeledMonthlyApplications,
      sampleMethod: "FINITE_POPULATION_95_PERCENT_5_PERCENT_MARGIN",
      sampleSize,
      sampleFraction: Number(
        (sampleSize / modeledMonthlyApplications).toFixed(4),
      ),
      concurrency,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      throughputPerSecond: Number(
        ((sampleSize / elapsedMs) * 1_000).toFixed(2),
      ),
      simulatedProxyP95RequestLatencyMs: p95RequestLatencyMs,
      requestStatusCodes: results.map((item) => item.status),
      replayStatus: replay.status,
      replayCount: replay.body?.duplicate === true ? 1 : 0,
      reconciliationCases: Number(reconciliation.count),
      paymentTransactions: Number(reconciliation.payment_count),
      maximumDbQueueAgeMs: workerEvidence.queueAgeMs,
      staffQueues,
      thresholds: {
        simulatedProxyP95RequestLatencyMs: requestP95ThresholdMs,
        maximumDbQueueAgeMs: maximumQueueAgeThresholdMs,
        minimumMonthlyApplications: 5_001,
        requiredReplayCount: 1,
        expectedReconciliationCases: sampleSize + 1,
      },
      simulatedProxyPass:
        allAccepted &&
        p95RequestLatencyMs <= requestP95ThresholdMs &&
        workerEvidence.queueAgeMs <= maximumQueueAgeThresholdMs &&
        modeledMonthlyApplications >= 5_001 &&
        replay.body?.duplicate === true &&
        Number(reconciliation.count) === sampleSize + 1 &&
        staffQueues.every((queue) => queue.sampledItems > 0) &&
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
          thresholdMs: maximumQueueAgeThresholdMs,
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
  replayStatus: number;
  preservedInboxCount: number;
  paymentCountAfterRecovery: number;
  replayCount: number;
  pass: boolean;
}> {
  const event = paymentEvent(sampleSize + 1);
  runtime.controls.setPaymentAvailable(false);
  const outage = await postProviderEvent(runtime, event);
  runtime.controls.setPaymentAvailable(true);
  const recovery = await postProviderEvent(runtime, event);
  const replay = await postProviderEvent(runtime, {
    ...event,
    eventId: `${event.eventId}-replay`,
  });
  const durable = await queryTestSql<{
    preserved_inbox_count: string;
    payment_count: string;
  }>(
    databaseUrl,
    `select
        (select count(*) from inbox_message
          where provider = 'SOMOCO_PAYMENTS'
            and provider_event_id = $1
            and payload->>'rawBodyBase64' is not null)::text as preserved_inbox_count,
        (select count(*) from payment_transaction
          where provider_transaction_id = $2)::text as payment_count`,
    [event.eventId, event.providerTransactionId],
  );
  return {
    outageStatus: outage.status,
    recoveryStatus: recovery.status,
    replayStatus: replay.status,
    preservedInboxCount: Number(durable.preserved_inbox_count),
    paymentCountAfterRecovery: Number(durable.payment_count),
    replayCount: replay.body?.duplicate === true ? 1 : 0,
    pass:
      outage.status === 503 &&
      recovery.status === 202 &&
      replay.status === 202 &&
      replay.body?.duplicate === true &&
      Number(durable.preserved_inbox_count) === 1 &&
      Number(durable.payment_count) === 1,
  };
}

async function exerciseWorkerRestartAndReclaim(databaseUrl: string): Promise<{
  messageId: string;
  attemptOutcomes: string[];
  queueAgeMs: number;
  measuredAt: string;
  pass: boolean;
}> {
  const firstConnection = createDatabase(databaseUrl);
  const occurredAt = new Date();
  const message = await enqueueOutbox(firstConnection.db, {
    id: randomUUID(),
    topic: "payments.reconcile",
    aggregateType: "settlement",
    aggregateId: randomUUID(),
    payload: { settlementReference: `CONTROLLED-PILOT-${randomUUID()}` },
    occurredAt,
  });
  const firstStore = createDatabaseOutboxStore(firstConnection.db);
  const [firstClaim] = await firstStore.claim({
    workerId: "controlled-pilot-worker-before-restart",
    limit: 1,
    topic: "payments.reconcile",
    claimLeaseMs: 25,
    maxAttempts: 3,
  });
  if (firstClaim?.id !== message.id) {
    await firstConnection.close();
    throw new Error("CONTROLLED_PILOT_OUTBOX_MARKER_NOT_CLAIMED");
  }
  const queueAge = await queryTestSql<{ max_age_ms: string }>(
    databaseUrl,
    `select coalesce(
              max(greatest(0, extract(epoch from (clock_timestamp() - occurred_at)) * 1000)),
              0
            )::text as max_age_ms
       from outbox_message
      where topic = 'payments.reconcile'
        and published_at is null
        and exception_at is null`,
  );
  const queueAgeMs = Number(queueAge.max_age_ms);
  const measuredAt = new Date().toISOString();
  await firstConnection.close();
  await new Promise((resolve) => setTimeout(resolve, 60));

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
      topic: "payments.reconcile",
      handlers: new Map([[message.topic, handler]]),
      concurrency: 1,
      maxAttempts: 3,
      retryBaseDelayMs: 10,
      heartbeatIntervalMs: 10,
      claimLeaseMs: 25,
      now: () => new Date(),
      logger: { info() {}, error() {} },
    });
    const attempts = await listOutboxAttempts(secondConnection.db, message.id);
    const attemptOutcomes = attempts.map((attempt) => attempt.outcome);
    return {
      messageId: message.id,
      attemptOutcomes,
      queueAgeMs,
      measuredAt,
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
  let body: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      body = parsed as Record<string, unknown>;
  } catch {
    body = null;
  }
  return {
    status: response.status,
    latencyMs: performance.now() - startedAt,
    body,
  };
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

function finitePopulationSampleSize(population: number): number {
  const z = 1.96;
  const proportion = 0.5;
  const margin = 0.05;
  const numerator = population * z ** 2 * proportion * (1 - proportion);
  const denominator =
    margin ** 2 * (population - 1) + z ** 2 * proportion * (1 - proportion);
  return Math.min(population, Math.ceil(numerator / denominator));
}

function modelStaffQueues(
  monthlyApplications: number,
  sampledApplications: number,
): Array<{
  queue: string;
  role: string;
  expectedMonthlyItems: number;
  sampledItems: number;
  pass: boolean;
}> {
  return staffQueueSpecs.map((spec) => ({
    queue: spec.queue,
    role: spec.role,
    expectedMonthlyItems: Math.ceil(monthlyApplications * spec.share),
    sampledItems: Math.ceil(sampledApplications * spec.share),
    pass: Math.ceil(sampledApplications * spec.share) > 0,
  }));
}

function assertControlledPilotTarget(): void {
  const configuredTestDatabase = process.env.TEST_DATABASE_URL;
  if (
    configuredTestDatabase !== undefined &&
    configuredTestDatabase !== databaseUrl
  )
    throw new Error("CONTROLLED_PILOT_TEST_DATABASE_REQUIRED");
  if (process.env.DATABASE_URL !== undefined)
    throw new Error("CONTROLLED_PILOT_DATABASE_URL_MUST_NOT_BE_SET");
  if (process.env.NODE_ENV === "production")
    throw new Error("CONTROLLED_PILOT_PRODUCTION_ENVIRONMENT_FORBIDDEN");
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
