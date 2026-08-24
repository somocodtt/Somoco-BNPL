import { describe, expect, it } from "vitest";
import {
  createPaymentReconciliationJob,
  createReconcilePaymentsHandler,
} from "../src/jobs/reconcile-payments.js";
import { createSendReceiptHandler } from "../src/jobs/send-notification.js";
import type { SmsPort } from "@somo/integrations";

describe("payment reconciliation worker job", () => {
  it("processes settlement batches outside the interactive request and is restart-safe at the sink", async () => {
    const calls: string[] = [];
    const job = createPaymentReconciliationJob({
      feed: {
        async fetchPending() {
          return [
            {
              settlementReference: "settle-1",
              provider: "SOMOCO_PAYMENTS",
              providerTotalMinorUnits: 1000n,
              receivedAt: new Date("2026-08-21T12:00:00.000Z"),
            },
          ];
        },
      },
      sink: {
        async compareSettlement(input) {
          calls.push(input.settlementReference);
          return { status: "MATCHED", varianceMinorUnits: "0" };
        },
      },
    });
    await expect(job.runOnce()).resolves.toEqual({
      processed: 1,
      matched: 1,
      variances: 0,
    });
    await expect(job.runOnce()).resolves.toEqual({
      processed: 1,
      matched: 1,
      variances: 0,
    });
    expect(calls).toEqual(["settle-1", "settle-1"]);
  });

  it("rejects settlement outbox payloads without a reference", async () => {
    const handler = createReconcilePaymentsHandler({
      job: {
        runOnce: async () => ({ processed: 0, matched: 0, variances: 0 }),
      },
    });
    await expect(
      handler({
        id: "id",
        topic: "payments.reconcile_requested",
        aggregateType: "payment_settlement_batch",
        aggregateId: "00000000-0000-0000-0000-000000000001",
        payload: {},
        occurredAt: new Date(),
        attempts: 1,
      }),
    ).rejects.toThrow("PAYMENT_SETTLEMENT_PAYLOAD_INVALID");
  });

  it("sends only a sanitized receipt link and current USSD instructions", async () => {
    const sent: Parameters<SmsPort["send"]>[0][] = [];
    const sms: SmsPort = {
      async send(input) {
        sent.push(input);
        return {
          providerReference: "sms-1",
          acceptedAt: "2026-08-21T12:00:00.000Z",
        };
      },
    };
    const handler = createSendReceiptHandler(sms);
    const message = {
      id: "receipt-message-1",
      topic: "payments.receipt_sms_requested",
      aggregateType: "payment_receipt",
      aggregateId: "00000000-0000-0000-0000-000000000001",
      payload: {
        phoneE164: "+233201234567",
        variables: {
          receiptLink:
            "https://customer.somo.example/account/receipts/receipt-1",
          ussdInstructions: "Dial *123# to pay.",
        },
      },
      occurredAt: new Date("2026-08-21T12:00:00.000Z"),
      attempts: 1,
    };
    await expect(handler(message)).resolves.toMatchObject({
      providerReference: "sms-1",
    });
    expect(sent[0]).toMatchObject({
      idempotencyKey: message.id,
      template: "PAYMENT_RECEIPT",
      variables: message.payload.variables,
    });
    await expect(
      handler({
        ...message,
        id: "receipt-message-2",
        payload: {
          ...message.payload,
          variables: {
            ...message.payload.variables,
            receiptLink: "https://customer.somo.example/receipt?secret=bad",
          },
        },
      }),
    ).rejects.toThrow("PERMANENT_WORKER_FAILURE");
  });
});
