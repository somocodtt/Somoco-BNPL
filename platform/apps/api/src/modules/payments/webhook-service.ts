import {
  completeInboxMessage,
  receiveInboxMessage,
  withTransaction,
  type Database,
  type DatabaseTransaction,
} from "@somo/db";
import type {
  CanonicalPaymentEvent,
  PaymentWebhookVerifier,
} from "@somo/integrations";
import { AppError } from "../../plugins/errors.js";
import {
  createLedgerService,
  type AllocationPolicy,
  type LedgerPostResult,
} from "./ledger-service.js";
import type { ReceiptService } from "./receipt-service.js";

export type { AllocationPolicy } from "./ledger-service.js";

export interface PaymentWebhookInput {
  rawBody: Uint8Array;
  signature: string;
  requestTimestamp: string;
  validateJson?: boolean;
}

export interface PaymentWebhookAcknowledgement {
  accepted: true;
  duplicate: boolean;
  eventId: string;
  outcome: "POSTED" | "QUARANTINED" | "REVERSED" | "REFUNDED";
  paymentTransactionId?: string;
  receiptId?: string;
  reason?: string;
}

export interface PaymentWebhookService {
  receive(input: PaymentWebhookInput): Promise<PaymentWebhookAcknowledgement>;
}

export function createPaymentWebhookService(options: {
  database: Database;
  verifier: PaymentWebhookVerifier;
  policy: AllocationPolicy;
  receipts?: ReceiptService;
}): PaymentWebhookService {
  const ledger = createLedgerService({
    database: options.database,
    ...(options.receipts === undefined ? {} : { receipts: options.receipts }),
  });
  return {
    async receive(input) {
      let event: CanonicalPaymentEvent;
      try {
        event = await options.verifier.verify(input);
      } catch (cause) {
        throw mapVerifierFailure(cause);
      }
      if (input.validateJson === true) {
        try {
          JSON.parse(new TextDecoder().decode(input.rawBody));
        } catch {
          throw new AppError(
            400,
            "MALFORMED_JSON",
            "The payment event body is malformed.",
          );
        }
      }
      validateCanonicalEvent(event);
      return withTransaction(options.database, async (tx) => {
        const inbox = await receiveInboxMessage(tx, {
          provider: "SOMOCO_PAYMENTS",
          providerEventId: event.eventId,
          eventType: event.eventType,
          payload: {
            eventId: event.eventId,
            eventType: event.eventType,
            providerTransactionId: event.providerTransactionId,
            customerReference: event.customerReference,
            amount: event.amount,
            occurredAt: event.occurredAt,
            settlementReference: event.settlementReference,
          },
          receivedAt: new Date(),
        });
        if (!inbox.inserted) {
          if (inbox.result === null || inbox.result === undefined) {
            throw new AppError(
              409,
              "PAYMENT_EVENT_IN_FLIGHT",
              "This payment event is already being processed.",
            );
          }
          return inbox.result as PaymentWebhookAcknowledgement;
        }
        const result = await processEvent({
          tx,
          ledger,
          policy: options.policy,
          event,
        });
        const acknowledgement: PaymentWebhookAcknowledgement = {
          accepted: true,
          duplicate: false,
          eventId: event.eventId,
          outcome: result.outcome,
          paymentTransactionId: result.paymentTransaction.id,
          ...(result.receiptId === undefined
            ? {}
            : { receiptId: result.receiptId }),
          ...(result.reason === undefined ? {} : { reason: result.reason }),
        };
        await completeInboxMessage(
          tx,
          inbox.id,
          inbox.processingToken!,
          acknowledgement,
        );
        return acknowledgement;
      });
    },
  };
}

async function processEvent(input: {
  tx: DatabaseTransaction;
  ledger: ReturnType<typeof createLedgerService>;
  policy: AllocationPolicy;
  event: CanonicalPaymentEvent;
}): Promise<LedgerPostResult> {
  const { event } = input;
  if (event.eventType === "PAYMENT_SUCCEEDED") {
    return input.ledger.post({
      transaction: input.tx,
      contractReference: event.customerReference,
      providerTransactionId: event.providerTransactionId,
      eventId: event.eventId,
      eventType: event.eventType,
      payerReference: event.payerPhoneE164,
      amountMinorUnits: BigInt(event.amount.minorUnits),
      currency: event.amount.currency,
      occurredAt: new Date(event.occurredAt),
      ...(event.settlementReference === undefined
        ? {}
        : { settlementReference: event.settlementReference }),
      policy: input.policy,
      providerPayload: {
        channel: event.channel,
        settlementReference: event.settlementReference,
      },
    });
  }
  return input.ledger.reverse({
    transaction: input.tx,
    originalProviderTransactionId: event.providerTransactionId,
    eventId: event.eventId,
    eventType: event.eventType,
    occurredAt: new Date(event.occurredAt),
    ...(event.settlementReference === undefined
      ? {}
      : { settlementReference: event.settlementReference }),
  });
}

function validateCanonicalEvent(event: CanonicalPaymentEvent): void {
  if (!isRecord(event))
    throw new AppError(
      400,
      "MALFORMED_PAYMENT_EVENT",
      "The payment event is malformed.",
    );
  if (
    !isNonEmptyString(event.eventId) ||
    !isNonEmptyString(event.providerTransactionId) ||
    !isNonEmptyString(event.payerPhoneE164) ||
    !isNonEmptyString(event.customerReference)
  )
    throw new AppError(
      400,
      "MALFORMED_PAYMENT_EVENT",
      "The payment event is malformed.",
    );
  if (event.channel !== "USSD" && event.channel !== "MOBILE_MONEY")
    throw new AppError(
      400,
      "MALFORMED_PAYMENT_EVENT",
      "The payment channel is malformed.",
    );
  if (
    !(
      [
        "PAYMENT_SUCCEEDED",
        "PAYMENT_REVERSED",
        "PAYMENT_REFUNDED",
      ] as readonly string[]
    ).includes(event.eventType)
  )
    throw new AppError(
      400,
      "UNKNOWN_PAYMENT_EVENT",
      "The payment event type is not supported.",
    );
  if (
    !isRecord(event.amount) ||
    event.amount.currency !== "GHS" ||
    !/^\d+$/.test(event.amount.minorUnits) ||
    BigInt(event.amount.minorUnits) <= 0n
  )
    throw new AppError(
      400,
      "MALFORMED_PAYMENT_EVENT",
      "The payment amount is malformed.",
    );
  if (
    !isNonEmptyString(event.occurredAt) ||
    !Number.isFinite(Date.parse(event.occurredAt))
  )
    throw new AppError(
      400,
      "MALFORMED_PAYMENT_EVENT",
      "The payment timestamp is malformed.",
    );
  if (
    event.settlementReference !== undefined &&
    !isNonEmptyString(event.settlementReference)
  )
    throw new AppError(
      400,
      "MALFORMED_PAYMENT_EVENT",
      "The settlement reference is malformed.",
    );
}

function mapVerifierFailure(cause: unknown): AppError {
  const code =
    cause instanceof Error ? cause.message : "PAYMENT_VERIFICATION_FAILED";
  if (code === "INVALID_SIGNATURE")
    return new AppError(
      401,
      code,
      "The payment signature could not be verified.",
    );
  if (
    code === "STALE_TIMESTAMP" ||
    code === "FUTURE_TIMESTAMP" ||
    code === "UNKNOWN_EVENT" ||
    code === "MALFORMED_JSON"
  )
    return new AppError(400, code, "The payment event could not be accepted.");
  return new AppError(
    401,
    "PAYMENT_VERIFICATION_FAILED",
    "The payment signature could not be verified.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
