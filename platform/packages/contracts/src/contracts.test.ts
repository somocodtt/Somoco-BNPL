import { describe, expect, it } from "vitest";
import {
  ApplicationCreateInputSchema,
  CanonicalPaymentEventSchema,
  GhanaCardNumberSchema,
  GuarantorInvitationSchema,
  MoneyDtoSchema,
  PaginationSchema,
  PhoneNumberSchema,
  ProblemDetailSchema,
  UuidSchema,
} from "./index.js";

const UUID = "6f9b8cf9-0be4-4d34-b245-7f69b2d80d10";

describe("shared transport contracts", () => {
  it("accepts only Ghana E.164 phone numbers", () => {
    expect(PhoneNumberSchema.safeParse("+233201234567").success).toBe(true);
    expect(PhoneNumberSchema.safeParse("+233001234567").success).toBe(false);
  });

  it("accepts uppercase Ghana Card numbers", () => {
    expect(GhanaCardNumberSchema.safeParse("GHA-123456789-0").success).toBe(
      true,
    );
    expect(GhanaCardNumberSchema.safeParse("gha-123456789-0").success).toBe(
      false,
    );
  });

  it("accepts UUID strings", () => {
    expect(UuidSchema.safeParse(UUID).success).toBe(true);
    expect(UuidSchema.safeParse("not-a-uuid").success).toBe(false);
  });

  it("accepts canonical signed 64-bit money DTO values", () => {
    expect(
      MoneyDtoSchema.safeParse({
        currency: "GHS",
        minorUnits: "9223372036854775807",
      }).success,
    ).toBe(true);
    expect(
      MoneyDtoSchema.safeParse({ currency: "GHS", minorUnits: "01" }).success,
    ).toBe(false);
    expect(
      MoneyDtoSchema.safeParse({
        currency: "GHS",
        minorUnits: "9223372036854775808",
      }).success,
    ).toBe(false);
  });

  it("defaults pagination and rejects unknown pagination fields", () => {
    expect(PaginationSchema.parse({})).toEqual({ limit: 25 });
    expect(PaginationSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(PaginationSchema.safeParse({ unexpected: true }).success).toBe(
      false,
    );
  });

  it("accepts bounded RFC 9457-style problem details", () => {
    expect(
      ProblemDetailSchema.safeParse({
        type: "https://somo.example/problems/invalid-input",
        title: "Invalid input",
        status: 400,
        code: "INVALID_INPUT",
        requestId: UUID,
      }).success,
    ).toBe(true);
    expect(
      ProblemDetailSchema.safeParse({
        type: "not a URI",
        title: "Invalid input",
        status: 400,
        code: "invalid-input",
      }).success,
    ).toBe(false);
  });

  it("rejects unknown application creation input fields", () => {
    expect(
      ApplicationCreateInputSchema.safeParse({
        vehicleModelId: UUID,
        repaymentFrequency: "MONTHLY",
        tenureMonths: 24,
      }).success,
    ).toBe(true);
    expect(
      ApplicationCreateInputSchema.safeParse({
        vehicleModelId: UUID,
        repaymentFrequency: "MONTHLY",
        tenureMonths: 24,
        applicantId: UUID,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown guarantor invitation fields", () => {
    expect(
      GuarantorInvitationSchema.safeParse({
        applicationId: UUID,
        guarantorPhoneNumber: "+233201234567",
      }).success,
    ).toBe(true);
    expect(
      GuarantorInvitationSchema.safeParse({
        applicationId: UUID,
        guarantorPhoneNumber: "+233201234567",
        token: "client-issued",
      }).success,
    ).toBe(false);
  });

  it("accepts canonical payment events with offset timestamps", () => {
    expect(
      CanonicalPaymentEventSchema.safeParse({
        eventId: "payment-event-001",
        eventType: "PAYMENT_SUCCEEDED",
        providerTransactionId: "provider-transaction-001",
        payerPhoneE164: "+233201234567",
        customerReference: "SOMO-001",
        amount: { currency: "GHS", minorUnits: "12345" },
        occurredAt: "2026-08-14T12:00:00+00:00",
      }).success,
    ).toBe(true);
    expect(
      CanonicalPaymentEventSchema.safeParse({
        eventId: "payment-event-001",
        eventType: "PAYMENT_SUCCEEDED",
        providerTransactionId: "provider-transaction-001",
        payerPhoneE164: "+233201234567",
        customerReference: "SOMO-001",
        amount: { currency: "GHS", minorUnits: "12345" },
        occurredAt: "2026-08-14T12:00:00Z",
        unexpected: true,
      }).success,
    ).toBe(false);
  });
});
