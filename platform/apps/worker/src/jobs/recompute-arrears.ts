import type { OutboxMessage } from "@somo/db";
import { PermanentWorkerError } from "./dispatch-outbox.js";

export interface ArrearsRecomputationPort {
  recompute(input: {
    idempotencyKey: string;
    contractId: string;
    asOfDate: string;
  }): Promise<unknown>;
}

export function createRecomputeArrearsHandler(port: ArrearsRecomputationPort) {
  return async (message: OutboxMessage) => {
    const asOfDate = arrearsDate(message.payload);
    return port.recompute({
      idempotencyKey: message.id,
      contractId: message.aggregateId,
      asOfDate,
    });
  };
}

function arrearsDate(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) invalidPayload();
  const asOfDate = (payload as Record<string, unknown>).asOfDate;
  if (typeof asOfDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    invalidPayload();
  }
  return asOfDate;
}

function invalidPayload(): never {
  throw new PermanentWorkerError("ARREARS_PAYLOAD_INVALID");
}
