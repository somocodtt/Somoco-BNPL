export interface CanonicalPaymentEvent {
  eventId: string;
  eventType: "PAYMENT_SUCCEEDED" | "PAYMENT_REVERSED" | "PAYMENT_REFUNDED";
  channel: "USSD" | "MOBILE_MONEY";
  providerTransactionId: string;
  payerPhoneE164: string;
  customerReference: string;
  amount: { currency: "GHS"; minorUnits: string };
  occurredAt: string;
  settlementReference?: string;
}

export interface PaymentWebhookVerifier {
  verify(input: {
    rawBody: Uint8Array;
    signature: string;
    requestTimestamp: string;
  }): Promise<CanonicalPaymentEvent>;
}
