import {
  collectionsRepo,
  withTransaction,
  type Database,
  type OutboxMessage,
} from "@somo/db";
import type { SmsPort } from "@somo/integrations";
import {
  createOutboxHandler,
  PermanentWorkerError,
} from "./dispatch-outbox.js";

export interface ReminderDeliveryContext {
  notificationId: string;
  phoneE164: string;
  template: "PAYMENT_DUE" | "PAYMENT_WARNING" | "ARREARS_WARNING";
  variables: Readonly<Record<string, string>>;
  status: "QUEUED" | "SENT" | "DELIVERED" | "FAILED";
  nextAttemptNumber: number;
}

export interface ReminderDeliveryStore {
  find(notificationId: string): Promise<ReminderDeliveryContext | null>;
  recordAttempt(input: {
    notificationId: string;
    attemptNumber: number;
    provider: string;
    providerReference: string;
    response: Record<string, unknown>;
    status: "SENT";
  }): Promise<void>;
}

export function createDatabaseReminderDeliveryStore(
  database: Database,
): ReminderDeliveryStore {
  return Object.freeze({
    find: (notificationId: string) =>
      withTransaction(database, (tx) =>
        collectionsRepo(tx).findNotificationDeliveryContext(notificationId),
      ),
    recordAttempt: (
      input: Parameters<ReminderDeliveryStore["recordAttempt"]>[0],
    ) =>
      withTransaction(database, (tx) =>
        collectionsRepo(tx).recordNotificationDeliveryAttempt(input),
      ),
  });
}

export function createSendReminderHandler(options: {
  sms: SmsPort;
  store: ReminderDeliveryStore;
}) {
  return createOutboxHandler(
    [options.sms],
    async (message: OutboxMessage) => {
      const notificationId = parseNotificationId(message.payload);
      const context = await options.store.find(notificationId);
      if (context === null)
        throw new PermanentWorkerError("REMINDER_NOTIFICATION_NOT_FOUND");
      if (context.status === "SENT" || context.status === "DELIVERED")
        return Object.freeze({ suppressed: true, notificationId });
      validateContext(context);
      const response = await options.sms.send({
        idempotencyKey: message.id,
        phoneE164: context.phoneE164,
        template: context.template,
        variables: context.variables,
      });
      await options.store.recordAttempt({
        notificationId,
        attemptNumber: context.nextAttemptNumber,
        provider: "SMS",
        providerReference: response.providerReference,
        response: { acceptedAt: response.acceptedAt },
        status: "SENT",
      });
      return response;
    },
    [[options.sms, "SMS"]],
  );
}

function parseNotificationId(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload))
    throw new PermanentWorkerError("REMINDER_PAYLOAD_INVALID");
  const value = (payload as Record<string, unknown>).notificationId;
  if (typeof value !== "string" || !/^[0-9a-f-]{36}$/i.test(value))
    throw new PermanentWorkerError("REMINDER_PAYLOAD_INVALID");
  return value;
}

function validateContext(context: ReminderDeliveryContext): void {
  if (!/^\+233[1-9][0-9]{8}$/.test(context.phoneE164))
    throw new PermanentWorkerError("REMINDER_PHONE_INVALID");
  if (
    !Number.isSafeInteger(context.nextAttemptNumber) ||
    context.nextAttemptNumber < 1
  )
    throw new PermanentWorkerError("REMINDER_ATTEMPT_INVALID");
  const variables = context.variables;
  for (const [key, value] of Object.entries(variables)) {
    if (typeof value !== "string" || value.length > 240)
      throw new PermanentWorkerError("REMINDER_VARIABLE_INVALID");
    if (/secret|token|otp|password|ghana.?card|latitude|longitude/i.test(key))
      throw new PermanentWorkerError("REMINDER_SENSITIVE_DATA_FORBIDDEN");
  }
  const link = variables.accountLink;
  if (typeof link !== "string")
    throw new PermanentWorkerError("REMINDER_ACCOUNT_LINK_REQUIRED");
  let parsed: URL;
  try {
    parsed = new URL(link);
  } catch {
    throw new PermanentWorkerError("REMINDER_ACCOUNT_LINK_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new PermanentWorkerError("REMINDER_ACCOUNT_LINK_INVALID");
  if (
    typeof variables.ussdInstructions !== "string" ||
    variables.ussdInstructions.trim().length === 0
  )
    throw new PermanentWorkerError("REMINDER_USSD_INSTRUCTIONS_REQUIRED");
  if (variables.cashPolicy !== "Cash is not accepted.")
    throw new PermanentWorkerError("REMINDER_CASH_POLICY_REQUIRED");
  if (
    !["PAYMENT_DUE", "PAYMENT_WARNING", "ARREARS_WARNING"].includes(
      context.template,
    )
  )
    throw new PermanentWorkerError("REMINDER_TEMPLATE_INVALID");
}
