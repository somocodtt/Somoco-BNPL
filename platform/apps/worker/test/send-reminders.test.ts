import { describe, expect, it } from "vitest";
import { createSendReminderHandler } from "../src/jobs/send-reminders.js";
import type { SmsPort } from "@somo/integrations";

describe("reminder notification worker", () => {
  it("uses a stable outbox idempotency key and records delivery evidence", async () => {
    const sent: Parameters<SmsPort["send"]>[0][] = [];
    const attempts: Record<string, unknown>[] = [];
    const sms: SmsPort = {
      async send(input) {
        sent.push(input);
        return {
          providerReference: "provider-reminder-1",
          acceptedAt: "2026-08-21T12:00:00.000Z",
        };
      },
    };
    const handler = createSendReminderHandler({
      sms,
      store: {
        async find(notificationId) {
          expect(notificationId).toBe("00000000-0000-4000-8000-000000000001");
          return {
            notificationId,
            phoneE164: "+233201234567",
            template: "ARREARS_WARNING",
            variables: {
              accountLink:
                "https://customer.somo.example/account/contracts/c/status",
              ussdInstructions: "Dial *123# to pay.",
              cashPolicy: "Cash is not accepted.",
            },
            status: "QUEUED" as const,
            nextAttemptNumber: 1,
          };
        },
        async recordAttempt(input) {
          attempts.push(input as unknown as Record<string, unknown>);
        },
      },
    });
    const message = {
      id: "outbox-reminder-1",
      topic: "collections.reminder_requested",
      aggregateType: "notification",
      aggregateId: "00000000-0000-4000-8000-000000000001",
      payload: { notificationId: "00000000-0000-4000-8000-000000000001" },
      occurredAt: new Date("2026-08-21T12:00:00.000Z"),
      attempts: 1,
    };
    await expect(handler(message)).resolves.toMatchObject({
      providerReference: "provider-reminder-1",
    });
    expect(sent[0]).toMatchObject({
      idempotencyKey: message.id,
      template: "ARREARS_WARNING",
    });
    expect(attempts[0]).toMatchObject({
      attemptNumber: 1,
      providerReference: "provider-reminder-1",
      status: "SENT",
    });
  });

  it("rejects secrets and non-secure account links before SMS", async () => {
    const handler = createSendReminderHandler({
      sms: {
        send: async () => ({
          providerReference: "unused",
          acceptedAt: new Date().toISOString(),
        }),
      },
      store: {
        async find() {
          return {
            notificationId: "00000000-0000-4000-8000-000000000002",
            phoneE164: "+233201234567",
            template: "PAYMENT_DUE",
            variables: {
              accountLink: "http://unsafe.example/account",
              ussdInstructions: "Dial *123#.",
              cashPolicy: "Cash is not accepted.",
              otp: "123456",
            },
            status: "QUEUED" as const,
            nextAttemptNumber: 1,
          };
        },
        async recordAttempt() {},
      },
    });
    await expect(
      handler({
        id: "outbox-reminder-2",
        topic: "collections.reminder_requested",
        aggregateType: "notification",
        aggregateId: "00000000-0000-4000-8000-000000000002",
        payload: { notificationId: "00000000-0000-4000-8000-000000000002" },
        occurredAt: new Date(),
        attempts: 1,
      }),
    ).rejects.toThrow("PERMANENT_WORKER_FAILURE");
  });
});
