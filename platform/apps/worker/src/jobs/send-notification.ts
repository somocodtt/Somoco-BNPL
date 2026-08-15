import type { OutboxMessage } from "@somo/db";
import { openOtpDelivery, type SmsPort } from "@somo/integrations";
import {
  createOutboxHandler,
  PermanentWorkerError,
} from "./dispatch-outbox.js";

export function createSendNotificationHandler(sms: SmsPort) {
  return createOutboxHandler([sms], async (message: OutboxMessage) => {
    const payload = notificationPayload(message.payload);
    return sms.send({
      idempotencyKey: message.id,
      phoneE164: payload.phoneE164,
      template: payload.template,
      variables: payload.variables,
    });
  });
}

export function createSendOtpHandler(sms: SmsPort, encryptionSecret: string) {
  return createOutboxHandler([sms], async (message: OutboxMessage) => {
    if (typeof message.payload !== "object" || message.payload === null) {
      invalidOtpPayload();
    }
    let delivery;
    try {
      delivery = openOtpDelivery(
        encryptionSecret,
        (message.payload as Record<string, unknown>)["delivery"],
      );
    } catch {
      invalidOtpPayload();
    }
    return sms.send({
      idempotencyKey: message.id,
      phoneE164: delivery.phoneE164,
      template: delivery.template,
      variables: delivery.variables,
    });
  });
}

function notificationPayload(payload: unknown): {
  phoneE164: string;
  template: string;
  variables: Readonly<Record<string, string>>;
} {
  if (typeof payload !== "object" || payload === null) invalidPayload();
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.phoneE164 !== "string" ||
    candidate.phoneE164.length === 0 ||
    typeof candidate.template !== "string" ||
    candidate.template.length === 0 ||
    typeof candidate.variables !== "object" ||
    candidate.variables === null ||
    Array.isArray(candidate.variables)
  ) {
    invalidPayload();
  }
  const variables = candidate.variables as Record<string, unknown>;
  if (Object.values(variables).some((value) => typeof value !== "string")) {
    invalidPayload();
  }
  return {
    phoneE164: candidate.phoneE164 as string,
    template: candidate.template as string,
    variables: Object.freeze({ ...variables }) as Readonly<
      Record<string, string>
    >,
  };
}

function invalidPayload(): never {
  throw new PermanentWorkerError("NOTIFICATION_PAYLOAD_INVALID");
}

function invalidOtpPayload(): never {
  throw new PermanentWorkerError("OTP_DELIVERY_PAYLOAD_INVALID");
}
