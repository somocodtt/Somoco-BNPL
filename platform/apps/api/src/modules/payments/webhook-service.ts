import { createHash } from "node:crypto";
import {
  completeInboxMessage,
  receiveInboxMessage,
  withTransaction,
  type Database,
  type DatabaseTransaction,
} from "@somo/db";
import type {
  AllocationPolicyEvidenceVerifier,
  CanonicalPaymentEvent,
  PaymentWebhookVerifier,
} from "@somo/integrations";
import { AppError } from "../../plugins/errors.js";
import {
  createAllocationPolicyEvidenceVerificationInput,
  createLedgerService,
  validateAllocationPolicy,
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
  depositReconciled?: boolean;
}

export interface PaymentWebhookService {
  receive(input: PaymentWebhookInput): Promise<PaymentWebhookAcknowledgement>;
}

export function createPaymentWebhookService(options: {
  database: Database;
  verifier: PaymentWebhookVerifier;
  policy: AllocationPolicy;
  receipts?: ReceiptService;
  /** Canonical production composition dependency. */
  allocationPolicyEvidenceVerifier?: AllocationPolicyEvidenceVerifier;
  /** Direct-service alias retained for focused non-production fixtures. */
  evidenceVerifier?: AllocationPolicyEvidenceVerifier;
}): PaymentWebhookService {
  validateAllocationPolicy(options.policy);
  const evidenceVerifier =
    options.allocationPolicyEvidenceVerifier ?? options.evidenceVerifier;
  let cachedEvidenceVerification: Promise<string> | undefined;
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
        if (isPaymentProviderUnavailable(cause)) {
          await preserveUnverifiedPayment(options.database, input);
          throw new AppError(
            503,
            "PAYMENT_PROVIDER_UNAVAILABLE",
            "Payment provider verification is temporarily unavailable; retry the event.",
          );
        }
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
          if (inbox.processingToken === null) {
            if (inbox.result !== null && inbox.result !== undefined)
              return inbox.result as PaymentWebhookAcknowledgement;
            throw new AppError(
              409,
              "PAYMENT_EVENT_IN_FLIGHT",
              "This payment event is already being processed.",
            );
          }
        }
        const duplicateProviderPayment =
          event.eventType === "PAYMENT_SUCCEEDED"
            ? await ledger.findDuplicateProviderTransaction({
                providerTransactionId: event.providerTransactionId,
                transaction: tx,
              })
            : null;
        if (duplicateProviderPayment !== null) {
          const acknowledgement = acknowledgementForResult(
            event,
            duplicateProviderPayment,
          );
          await completeInboxMessage(
            tx,
            inbox.id,
            inbox.processingToken!,
            acknowledgement,
          );
          return acknowledgement;
        }
        const policyAttestationReference =
          event.eventType === "PAYMENT_SUCCEEDED"
            ? await verifyAllocationPolicyEvidence()
            : undefined;
        const result = await processEvent({
          tx,
          ledger,
          policy: options.policy,
          event,
          ...(policyAttestationReference === undefined
            ? {}
            : { policyAttestationReference }),
        });
        const acknowledgement = acknowledgementForResult(event, result);
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

  async function verifyAllocationPolicyEvidence(): Promise<string | undefined> {
    if (evidenceVerifier === undefined) return undefined;
    if (cachedEvidenceVerification === undefined) {
      const verificationInput = createAllocationPolicyEvidenceVerificationInput(
        options.policy,
      );
      cachedEvidenceVerification = Promise.resolve()
        .then(() => evidenceVerifier.verify(verificationInput))
        .then((verification) => {
          if (
            verification === null ||
            typeof verification !== "object" ||
            typeof verification.attestationReference !== "string" ||
            verification.attestationReference.trim() === ""
          )
            throw new Error("ATTESTATION_REFERENCE_INVALID");
          return verification.attestationReference;
        });
    }
    try {
      return await cachedEvidenceVerification;
    } catch {
      cachedEvidenceVerification = undefined;
      throw new AppError(
        409,
        "ALLOCATION_POLICY_EVIDENCE_NOT_VERIFIED",
        "The allocation policy evidence could not be verified.",
      );
    }
  }
}

async function processEvent(input: {
  tx: DatabaseTransaction;
  ledger: ReturnType<typeof createLedgerService>;
  policy: AllocationPolicy;
  event: CanonicalPaymentEvent;
  policyAttestationReference?: string;
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
      ...(input.policyAttestationReference === undefined
        ? {}
        : { policyAttestationReference: input.policyAttestationReference }),
      providerPayload: {
        channel: event.channel,
        settlementReference: event.settlementReference,
        allocationPolicyVersion: input.policy.version,
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

function acknowledgementForResult(
  event: CanonicalPaymentEvent,
  result: LedgerPostResult,
): PaymentWebhookAcknowledgement {
  return {
    accepted: true,
    duplicate: result.reason === "DUPLICATE_PROVIDER_TRANSACTION",
    eventId: event.eventId,
    outcome: result.outcome,
    paymentTransactionId: result.paymentTransaction.id,
    ...(result.receiptId === undefined ? {} : { receiptId: result.receiptId }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    ...(result.depositReconciled ? { depositReconciled: true } : {}),
  };
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
  if (isPaymentProviderUnavailable(cause))
    return new AppError(
      503,
      "PAYMENT_PROVIDER_UNAVAILABLE",
      "Payment provider verification is temporarily unavailable; retry the event.",
    );
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

async function preserveUnverifiedPayment(
  database: Database,
  input: PaymentWebhookInput,
): Promise<void> {
  const rawText = new TextDecoder().decode(input.rawBody);
  const parsed = parseUntrustedRecord(rawText);
  const digest = createHash("sha256")
    .update(input.rawBody)
    .update(input.signature)
    .update(input.requestTimestamp)
    .digest("hex");
  const providerEventId =
    boundedString(parsed?.eventId, 256) ?? `unverified-${digest}`;
  const eventType =
    boundedString(parsed?.eventType, 128) ?? "PAYMENT_PROVIDER_UNAVAILABLE";
  await withTransaction(database, async (tx) => {
    await receiveInboxMessage(tx, {
      provider: "SOMOCO_PAYMENTS",
      providerEventId,
      eventType,
      payload: {
        preservationReason: "PAYMENT_PROVIDER_UNAVAILABLE",
        rawBodyBase64: Buffer.from(input.rawBody).toString("base64"),
        signature: input.signature,
        requestTimestamp: input.requestTimestamp,
      },
      receivedAt: new Date(),
      claim: false,
    });
  });
}

function isPaymentProviderUnavailable(cause: unknown): boolean {
  const values = [
    cause instanceof Error ? cause.message : String(cause),
    ...(isRecord(cause) && typeof cause.code === "string" ? [cause.code] : []),
  ];
  return values.some((code) =>
    [
      "PAYMENT_PROVIDER_UNAVAILABLE",
      "SIMULATOR_PROVIDER_UNAVAILABLE",
      "PROVIDER_UNAVAILABLE",
      "ETIMEDOUT",
      "ECONNRESET",
      "ECONNREFUSED",
      "EAI_AGAIN",
    ].includes(code),
  );
}

function parseUntrustedRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= maxLength
    ? value
    : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
