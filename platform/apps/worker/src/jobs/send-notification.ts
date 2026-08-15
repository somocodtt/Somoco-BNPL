import {
  findOtpDeliveryContext,
  type Database,
  type OutboxMessage,
} from "@somo/db";
import { deriveOtpCode, type SmsPort } from "@somo/integrations";
import {
  createOutboxHandler,
  PermanentWorkerError,
} from "./dispatch-outbox.js";

export function createSendNotificationHandler(sms: SmsPort) {
  return createOutboxHandler(
    [sms],
    async (message: OutboxMessage) => {
      const payload = notificationPayload(message.payload);
      return sms.send({
        idempotencyKey: message.id,
        phoneE164: payload.phoneE164,
        template: payload.template,
        variables: payload.variables,
      });
    },
    [[sms, "SMS"]],
  );
}

export interface OtpDeliveryLookup {
  find(challengeId: string): Promise<{
    phoneE164: string;
    expiresAt: Date;
    invalidatedAt: Date | null;
    deliveryFailedAt: Date | null;
  } | null>;
}

export function createDatabaseOtpDeliveryLookup(
  database: Database,
): OtpDeliveryLookup {
  return Object.freeze({
    find: (challengeId: string) =>
      findOtpDeliveryContext(database, challengeId),
  });
}

export function createSendOtpHandler(options: {
  sms: SmsPort;
  lookup: OtpDeliveryLookup;
  derivationSecret: string;
  codeLength: number;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  return createOutboxHandler(
    [options.sms],
    async (message: OutboxMessage) => {
      const challengeId = otpChallengeId(message.payload);
      const delivery = await options.lookup.find(challengeId);
      if (
        delivery === null ||
        delivery.invalidatedAt !== null ||
        delivery.deliveryFailedAt !== null ||
        delivery.expiresAt.getTime() <= now().getTime()
      ) {
        return Object.freeze({ suppressed: true });
      }
      const code = deriveOtpCode(
        options.derivationSecret,
        challengeId,
        options.codeLength,
      );
      return options.sms.send({
        idempotencyKey: message.id,
        phoneE164: delivery.phoneE164,
        template: "CUSTOMER_AUTHENTICATION_OTP",
        variables: { code },
      });
    },
    [[options.sms, "SMS"]],
  );
}

function otpChallengeId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) invalidOtpPayload();
  const challengeId = (payload as Record<string, unknown>)["challengeId"];
  if (typeof challengeId !== "string") invalidOtpPayload();
  return challengeId;
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
