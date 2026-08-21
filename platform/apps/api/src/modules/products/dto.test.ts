import { describe, expect, it } from "vitest";
import { serializeOfferDto, serializeRuleDto } from "./dto.js";

describe("financing HTTP DTOs", () => {
  it("rejects malformed or unapproved fee policies instead of coercing them", () => {
    const rule = {
      id: "rule-fees",
      productId: "product-1",
      productCode: "PILOT",
      productName: "Pilot",
      vehicleModelId: "model-1",
      versionNumber: 1,
      sellingPriceMinor: 100_000n,
      minimumDepositMinor: 30_000n,
      annualRateBps: 0,
      allowedTenuresMonths: [6],
      repaymentFrequencies: ["MONTHLY"] as const,
      calculationMethod: "FLAT_MARKUP" as const,
      eligibilityPolicy: {},
      requiredEvidence: [],
      exceptionPolicy: {},
      disclosureVersion: null,
      fixtureHashes: [],
      licencePermitted: false,
      approved: false,
      requestedBy: null,
      approvedBy: null,
      approvedAt: null,
      effectiveFrom: null,
      effectiveUntil: null,
      publishedAt: null,
    };
    expect(() => serializeRuleDto({ ...rule, permittedFees: null as never } as never)).toThrow("FEES_POLICY_INVALID");
    expect(() => serializeRuleDto({ ...rule, permittedFees: { serviceFee: "unapproved" } } as never)).toThrow("FEES_POLICY_INVALID");
  });

  it("requires the computed gate status on published rule DTOs", () => {
    expect(() => serializeRuleDto({
      id: "rule-missing-gate",
      productId: "product-1",
      productCode: "PILOT",
      productName: "Pilot",
      vehicleModelId: "model-1",
      versionNumber: 1,
      sellingPriceMinor: 100_000n,
      minimumDepositMinor: 30_000n,
      annualRateBps: 0,
      allowedTenuresMonths: [6],
      repaymentFrequencies: ["MONTHLY"],
      calculationMethod: "FLAT_MARKUP",
      permittedFees: {},
      eligibilityPolicy: {},
      requiredEvidence: [],
      exceptionPolicy: {},
      disclosureVersion: null,
      fixtureHashes: [],
      licencePermitted: false,
      approved: true,
      requestedBy: null,
      approvedBy: "checker-1",
      approvedAt: new Date(),
      effectiveFrom: new Date(),
      effectiveUntil: null,
      publishedAt: new Date(),
    })).toThrow("RULE_GATE_STATUS_REQUIRED");
  });

  it("serializes every monetary value and schedule field without bigint values", () => {
    const rule = serializeRuleDto({
      id: "rule-1",
      productId: "product-1",
      productCode: "PILOT",
      productName: "Pilot",
      vehicleModelId: "model-1",
      versionNumber: 2,
      sellingPriceMinor: 100_000n,
      minimumDepositMinor: 30_000n,
      annualRateBps: 1200,
      allowedTenuresMonths: [6],
      repaymentFrequencies: ["MONTHLY"],
      calculationMethod: "FLAT_MARKUP",
      permittedFees: {},
      eligibilityPolicy: {},
      requiredEvidence: [],
      exceptionPolicy: {},
      disclosureVersion: "test-disclosure-v1",
      disclosureContent: { version: "test-disclosure-v1", body: "Synthetic test disclosure" },
      disclosureHash: "c".repeat(64),
      fixtureHashes: ["a".repeat(64)],
      licencePermitted: true,
      approved: true,
      requestedBy: "maker-1",
      approvedBy: "checker-1",
      approvedAt: new Date("2026-08-20T00:00:00.000Z"),
      effectiveFrom: new Date("2026-08-20T00:00:00.000Z"),
      effectiveUntil: null,
      publishedAt: new Date("2026-08-20T00:00:01.000Z"),
      gateStatus: "OPEN",
    });
    const offer = serializeOfferDto({
      id: "offer-1",
      applicationId: "application-1",
      status: "PENDING",
      version: 1,
      acceptedVersionId: null,
      acceptedAt: null,
      acceptedHash: null,
      consentAt: null,
      expiresAt: new Date("2026-08-21T00:00:00.000Z"),
      acceptedByPersonId: null,
      offerVersion: {
        id: "offer-version-1",
        versionNumber: 1,
        financingRuleVersionId: "rule-1",
        principalMinor: 70_000n,
        depositMinor: 30_000n,
        totalPayableMinor: 77_000n,
        canonicalHash: "b".repeat(64),
        terms: {
          priceMinor: "100000",
          depositMinor: "30000",
          financeChargeMinor: "7000",
          totalPayableMinor: "77000",
          fees: {},
          disclosureVersion: "test-disclosure-v1",
          disclosureContent: { version: "test-disclosure-v1", body: "Synthetic test disclosure" },
          disclosureHash: "c".repeat(64),
          ruleVersionId: "rule-1",
          fixtureHash: "d".repeat(64),
          exceptionId: "exception-1",
          acceptedHash: "e".repeat(64),
          installments: [{ sequence: 1, dueDate: "2026-09-01", totalMinor: "38500" }],
        },
      },
    });

    expect(rule).toMatchObject({
      sellingPriceMinor: "100000",
      minimumDepositMinor: "30000",
      status: "PUBLISHED",
      gate: "OPEN",
      disclosureContent: { body: "Synthetic test disclosure" },
      disclosureHash: "c".repeat(64),
    });
    expect(offer).toMatchObject({
      priceMinor: "100000",
      depositMinor: "30000",
      financeChargeMinor: "7000",
      totalPayableMinor: "77000",
      installments: [{ totalMinor: "38500" }],
      fees: {},
      disclosureVersion: "test-disclosure-v1",
      disclosureContent: { body: "Synthetic test disclosure" },
    });
    expect(offer).not.toHaveProperty("terms");
    expect(offer).not.toHaveProperty("fixtureHash");
    expect(offer).not.toHaveProperty("exceptionId");
    expect(offer).not.toHaveProperty("ruleVersionId");
    expect(offer).not.toHaveProperty("acceptedHash");
    expect(JSON.stringify(rule)).not.toContain("BigInt");
    expect(() => JSON.stringify(offer)).not.toThrow();
    expect(() => serializeOfferDto({
      ...offerRecordForDtoTest(),
      offerVersion: {
        ...offerRecordForDtoTest().offerVersion!,
        terms: { fees: null },
      },
    })).toThrow("FEES_POLICY_INVALID");
  });
});

function offerRecordForDtoTest() {
  return {
    id: "offer-fees",
    applicationId: "application-1",
    status: "PENDING" as const,
    version: 1,
    acceptedVersionId: null,
    acceptedAt: null,
    acceptedHash: null,
    consentAt: null,
    expiresAt: new Date("2026-08-21T00:00:00.000Z"),
    acceptedByPersonId: null,
    offerVersion: {
      id: "offer-version-1",
      versionNumber: 1,
      financingRuleVersionId: "rule-1",
      principalMinor: 70_000n,
      depositMinor: 30_000n,
      totalPayableMinor: 77_000n,
      canonicalHash: "b".repeat(64),
      terms: { fees: {} },
    },
  };
}
