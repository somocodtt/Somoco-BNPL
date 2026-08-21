import {
  findGuarantorInvitationDeliveryContext,
  findOtpDeliveryContext,
  type Database,
  type OutboxMessage,
} from "@somo/db";
import {
  deriveGuarantorInvitationToken,
  deriveOtpCode,
  validateGuarantorInvitationDeliveryPolicy,
  validateOtpDeliveryPolicy,
  type SmsPort,
} from "@somo/integrations";
import {
  createOutboxHandler,
  PermanentWorkerError,
} from "./dispatch-outbox.js";

export interface GuarantorInvitationDeliveryLookup {
  find(invitationId: string): Promise<{
    phoneE164: string;
    expiresAt: Date;
    claimedAt: Date | null;
    revokedAt: Date | null;
  } | null>;
}

export function createDatabaseGuarantorInvitationDeliveryLookup(
  database: Database,
): GuarantorInvitationDeliveryLookup {
  return Object.freeze({
    find: (invitationId: string) =>
      findGuarantorInvitationDeliveryContext(database, invitationId),
  });
}

export function createSendGuarantorInvitationHandler(options: {
  sms: SmsPort;
  lookup: GuarantorInvitationDeliveryLookup;
  derivationSecret: string;
  derivationKeyId: string;
  tokenVersion: number;
  invitationBaseUrl: string;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const policy = validateGuarantorInvitationDeliveryPolicy({
    derivationSecret: options.derivationSecret,
    derivationKeyId: options.derivationKeyId,
    tokenVersion: options.tokenVersion,
  });
  const invitationBaseUrl = validateInvitationBaseUrl(
    options.invitationBaseUrl,
  );
  return createOutboxHandler(
    [options.sms],
    async (message: OutboxMessage) => {
      const payload = guarantorInvitationPayload(message.payload);
      if (
        payload.derivationKeyId !== policy.derivationKeyId ||
        payload.tokenVersion !== policy.tokenVersion
      ) {
        throw new PermanentWorkerError(
          "GUARANTOR_INVITATION_DELIVERY_POLICY_MISMATCH",
        );
      }
      const delivery = await options.lookup.find(payload.invitationId);
      if (
        delivery === null ||
        delivery.claimedAt !== null ||
        delivery.revokedAt !== null ||
        delivery.expiresAt.getTime() <= now().getTime()
      ) {
        return Object.freeze({ suppressed: true });
      }
      const token = deriveGuarantorInvitationToken(
        options.derivationSecret,
        payload.invitationId,
        policy.tokenVersion,
      );
      const invitationUrl = new URL(invitationBaseUrl);
      invitationUrl.hash = new URLSearchParams({
        invitation: token,
      }).toString();
      return options.sms.send({
        idempotencyKey: message.id,
        phoneE164: delivery.phoneE164,
        template: "GUARANTOR_INVITATION",
        variables: { invitationLink: invitationUrl.toString() },
      });
    },
    [[options.sms, "SMS"]],
    { guarantorInvitationDeliveryPolicy: policy },
  );
}

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

export function createSendReceiptHandler(sms: SmsPort) {
  return createOutboxHandler(
    [sms],
    async (message: OutboxMessage) => {
      const payload = receiptPayload(message.payload);
      return sms.send({
        idempotencyKey: message.id,
        phoneE164: payload.phoneE164,
        template: "PAYMENT_RECEIPT",
        variables: {
          receiptLink: payload.receiptLink,
          ussdInstructions: payload.ussdInstructions,
        },
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
  derivationKeyId: string;
  codeLength: number;
  now?: () => Date;
}) {
  const now = options.now ?? (() => new Date());
  const policy = validateOtpDeliveryPolicy({
    derivationSecret: options.derivationSecret,
    derivationKeyId: options.derivationKeyId,
    codeLength: options.codeLength,
  });
  return createOutboxHandler(
    [options.sms],
    async (message: OutboxMessage) => {
      const payload = otpPayload(message.payload);
      if (
        payload.derivationKeyId !== policy.derivationKeyId ||
        payload.codeLength !== policy.codeLength
      ) {
        throw new PermanentWorkerError("OTP_DELIVERY_POLICY_MISMATCH");
      }
      const delivery = await options.lookup.find(payload.challengeId);
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
        payload.challengeId,
        policy.codeLength,
      );
      return options.sms.send({
        idempotencyKey: message.id,
        phoneE164: delivery.phoneE164,
        template: "CUSTOMER_AUTHENTICATION_OTP",
        variables: { code },
      });
    },
    [[options.sms, "SMS"]],
    { otpDeliveryPolicy: policy },
  );
}

function otpPayload(payload: unknown): {
  challengeId: string;
  derivationKeyId: string;
  codeLength: number;
} {
  if (typeof payload !== "object" || payload === null) invalidOtpPayload();
  const candidate = payload as Record<string, unknown>;
  const challengeId = candidate["challengeId"];
  const derivationKeyId = candidate["derivationKeyId"];
  const codeLength = candidate["codeLength"];
  if (
    typeof challengeId !== "string" ||
    typeof derivationKeyId !== "string" ||
    typeof codeLength !== "number"
  ) {
    invalidOtpPayload();
  }
  return { challengeId, derivationKeyId, codeLength };
}

function guarantorInvitationPayload(payload: unknown): {
  invitationId: string;
  derivationKeyId: string;
  tokenVersion: number;
} {
  if (typeof payload !== "object" || payload === null) {
    invalidGuarantorInvitationPayload();
  }
  const candidate = payload as Record<string, unknown>;
  const invitationId = candidate["invitationId"];
  const derivationKeyId = candidate["derivationKeyId"];
  const tokenVersion = candidate["tokenVersion"];
  if (
    typeof invitationId !== "string" ||
    typeof derivationKeyId !== "string" ||
    typeof tokenVersion !== "number"
  ) {
    invalidGuarantorInvitationPayload();
  }
  return { invitationId, derivationKeyId, tokenVersion };
}

function validateInvitationBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "") {
    throw new Error("GUARANTOR_INVITATION_BASE_URL_INVALID");
  }
  return url.toString();
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

function receiptPayload(payload: unknown): {
  phoneE164: string;
  receiptLink: string;
  ussdInstructions: string;
} {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    invalidPayload();
  const candidate = payload as Record<string, unknown>;
  const phoneE164 = candidate.phoneE164;
  const variables = candidate.variables;
  if (
    typeof phoneE164 !== "string" ||
    !/^\+[1-9][0-9]{7,14}$/.test(phoneE164) ||
    typeof variables !== "object" ||
    variables === null ||
    Array.isArray(variables)
  )
    invalidPayload();
  const values = variables as Record<string, unknown>;
  const receiptLink = values.receiptLink;
  const ussdInstructions = values.ussdInstructions;
  let url: URL;
  try {
    url = new URL(typeof receiptLink === "string" ? receiptLink : "");
  } catch {
    invalidPayload();
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    typeof receiptLink !== "string" ||
    typeof ussdInstructions !== "string" ||
    ussdInstructions.trim().length === 0 ||
    ussdInstructions.length > 240
  )
    invalidPayload();
  return { phoneE164, receiptLink, ussdInstructions };
}

function invalidPayload(): never {
  throw new PermanentWorkerError("NOTIFICATION_PAYLOAD_INVALID");
}

function invalidOtpPayload(): never {
  throw new PermanentWorkerError("OTP_DELIVERY_PAYLOAD_INVALID");
}

function invalidGuarantorInvitationPayload(): never {
  throw new PermanentWorkerError("GUARANTOR_INVITATION_PAYLOAD_INVALID");
}
