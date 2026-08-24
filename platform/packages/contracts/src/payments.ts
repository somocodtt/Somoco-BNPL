import { z } from "zod";
import { MoneyDtoSchema, PhoneNumberSchema } from "./common.js";

export const CanonicalPaymentEventSchema = z.strictObject({
  eventId: z.string().min(1).max(128),
  eventType: z.enum([
    "PAYMENT_SUCCEEDED",
    "PAYMENT_REVERSED",
    "PAYMENT_REFUNDED",
  ]),
  channel: z.enum(["USSD", "MOBILE_MONEY"]),
  providerTransactionId: z.string().min(1).max(128),
  payerPhoneE164: PhoneNumberSchema,
  customerReference: z.string().min(1).max(64),
  amount: MoneyDtoSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  settlementReference: z.string().min(1).max(128).optional(),
});

export type CanonicalPaymentEvent = z.infer<typeof CanonicalPaymentEventSchema>;
