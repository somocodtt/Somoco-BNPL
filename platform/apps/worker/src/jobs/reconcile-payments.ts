import { createOutboxHandler, type OutboxHandler } from "./dispatch-outbox.js";
import type { OutboxMessage } from "@somo/db";

export interface SettlementRecord {
  settlementReference: string;
  provider: "SOMOCO_PAYMENTS";
  providerTotalMinorUnits: bigint;
  receivedAt: Date;
}

export interface SettlementFeed {
  fetchPending(): Promise<readonly SettlementRecord[]>;
}

export interface SettlementSink {
  compareSettlement(input: SettlementRecord): Promise<{
    status: "MATCHED" | "VARIANCE";
    varianceMinorUnits: string;
  }>;
}

export interface PaymentReconciliationRunResult {
  processed: number;
  matched: number;
  variances: number;
}

export interface PaymentReconciliationJob {
  runOnce(): Promise<PaymentReconciliationRunResult>;
}

export function createPaymentReconciliationJob(options: {
  feed: SettlementFeed;
  sink: SettlementSink;
}): PaymentReconciliationJob {
  return {
    async runOnce() {
      const settlements = await options.feed.fetchPending();
      let matched = 0;
      let variances = 0;
      for (const settlement of settlements) {
        const comparison = await options.sink.compareSettlement(settlement);
        if (comparison.status === "MATCHED") matched += 1;
        else variances += 1;
      }
      return { processed: settlements.length, matched, variances };
    },
  };
}

export function createReconcilePaymentsHandler(options: {
  job: PaymentReconciliationJob;
}): OutboxHandler {
  return createOutboxHandler([], async (message: OutboxMessage) => {
    const payload = parseSettlementPayload(message.payload);
    const result = await options.job.runOnce();
    return { settlementReference: payload.settlementReference, ...result };
  });
}

function parseSettlementPayload(payload: unknown): {
  settlementReference: string;
} {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new Error("PAYMENT_SETTLEMENT_PAYLOAD_INVALID");
  const settlementReference = (payload as Record<string, unknown>)
    .settlementReference;
  if (
    typeof settlementReference !== "string" ||
    settlementReference.trim().length === 0
  )
    throw new Error("PAYMENT_SETTLEMENT_PAYLOAD_INVALID");
  return { settlementReference };
}
