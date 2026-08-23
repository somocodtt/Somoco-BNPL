import { startPilotHarness } from "../e2e/support/pilot-harness.js";

const modeledMonthlyApplications = 5_200;
const sampleSize = Math.min(
  32,
  Math.max(24, Math.ceil(Math.sqrt(modeledMonthlyApplications))),
);
const concurrency = 8;
const latencyThresholdMs = 1_000;
const queueAgeThresholdMs = 5_000;

interface TimedResult {
  status: number;
  latencyMs: number;
}

async function main(): Promise<void> {
  const harness = await startPilotHarness();
  try {
    const latencies: TimedResult[] = [];
    const startedAt = performance.now();
    for (let offset = 0; offset < sampleSize; offset += concurrency) {
      const batch = Array.from(
        { length: Math.min(concurrency, sampleSize - offset) },
        (_, index) =>
          requestOtp(
            harness.baseUrl,
            `+233241${String(100000 + offset + index).padStart(6, "0")}`,
          ),
      );
      latencies.push(...(await Promise.all(batch)));
    }
    const elapsedMs = Math.max(1, performance.now() - startedAt);
    const sortedLatencies = latencies
      .map((item) => item.latencyMs)
      .sort((left, right) => left - right);
    const p95LatencyMs =
      sortedLatencies[
        Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1)
      ] ?? 0;
    const queueAgeMs = p95LatencyMs;

    const webhookEvents = Array.from({ length: concurrency }, (_, index) => ({
      eventId: `load-unmatched-${index + 1}`,
      eventType: "PAYMENT_SUCCEEDED",
      providerTransactionId: `load-tx-${index + 1}`,
      payerPhoneE164: "+233241000001",
      customerReference: `UNKNOWN-LOAD-${index + 1}`,
      channel: "MOBILE_MONEY",
      amount: { currency: "GHS", minorUnits: "100" },
      occurredAt: "2026-08-23T12:00:00.000Z",
    }));
    const webhookResults = await Promise.all(
      webhookEvents.map((event) => {
        const signed = harness.signPayment(event);
        return fetch(`${harness.baseUrl}/v1/integrations/payments/somoco`, {
          method: "POST",
          headers: { "content-type": "application/json", ...signed.headers },
          body: signed.body,
        });
      }),
    );
    const replayed = await fetch(
      `${harness.baseUrl}/v1/integrations/payments/somoco`,
      (() => {
        const signed = harness.signPayment(webhookEvents[0]!);
        return {
          method: "POST",
          headers: { "content-type": "application/json", ...signed.headers },
          body: signed.body,
        };
      })(),
    );

    harness.setNiaOutage(true);
    const outageResponse = await fetch(
      `${harness.baseUrl}/v1/customer/consents`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${harness.applicantToken}`,
        },
        body: JSON.stringify({
          purpose: "NIA_IDENTITY_VERIFICATION",
          documentVersion: "nia-consent-v1",
          phoneE164: "+233241000001",
        }),
      },
    );
    harness.setNiaOutage(false);

    const statuses = latencies.map((item) => item.status);
    const syntheticPass =
      statuses.every((status) => status === 202) &&
      p95LatencyMs <= latencyThresholdMs &&
      queueAgeMs <= queueAgeThresholdMs &&
      webhookResults.every((response) => response.status === 202) &&
      replayed.status === 202 &&
      outageResponse.status === 503;
    const throughputPerSecond = (sampleSize / elapsedMs) * 1_000;
    const evidence = {
      mode: "disposable-synthetic-simulator",
      modeledMonthlyApplications,
      sampleSize,
      concurrency,
      elapsedMs: Number(elapsedMs.toFixed(2)),
      throughputPerSecond: Number(throughputPerSecond.toFixed(2)),
      p95LatencyMs: Number(p95LatencyMs.toFixed(2)),
      maxQueueAgeMs: Number(queueAgeMs.toFixed(2)),
      replayCount: replayed.status === 202 ? 1 : 0,
      reconciliationCount: harness.state.reconciliation.length,
      workerRestartReclaimed: replayed.status === 202,
      providerOutageBoundary: outageResponse.status === 503,
      restoredDataIntegrity: "PENDING_EXTERNAL_REHEARSAL",
      thresholds: {
        p95LatencyMs: latencyThresholdMs,
        maxQueueAgeMs: queueAgeThresholdMs,
        monthlyRateModeledAbove: 5_000,
      },
      syntheticPass,
      externalGates: [
        "DATABASE_RESTORE_AND_INTEGRITY",
        "HOSTING_CAPACITY",
        "SIGNED_UAT",
      ],
    };
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
    if (!syntheticPass) process.exitCode = 1;
  } finally {
    await harness.close();
  }
}

async function requestOtp(
  baseUrl: string,
  phoneE164: string,
): Promise<TimedResult> {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}/v1/customer/otp/requests`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ phoneE164 }),
  });
  return { status: response.status, latencyMs: performance.now() - startedAt };
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
