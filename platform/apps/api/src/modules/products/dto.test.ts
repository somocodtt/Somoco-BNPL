import { describe, expect, it } from "vitest";
import { serializeOfferDto, serializeRuleDto } from "./dto.js";

describe("financing HTTP DTOs", () => {
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
      fixtureHashes: ["a".repeat(64)],
      licencePermitted: true,
      approved: true,
      requestedBy: "maker-1",
      approvedBy: "checker-1",
      approvedAt: new Date("2026-08-20T00:00:00.000Z"),
      effectiveFrom: new Date("2026-08-20T00:00:00.000Z"),
      effectiveUntil: null,
      publishedAt: new Date("2026-08-20T00:00:01.000Z"),
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
          installments: [{ sequence: 1, dueDate: "2026-09-01", totalMinor: "38500" }],
        },
      },
    });

    expect(rule).toMatchObject({ sellingPriceMinor: "100000", minimumDepositMinor: "30000" });
    expect(offer).toMatchObject({
      priceMinor: "100000",
      depositMinor: "30000",
      financeChargeMinor: "7000",
      totalPayableMinor: "77000",
      installments: [{ totalMinor: "38500" }],
      fees: {},
      disclosureVersion: "test-disclosure-v1",
    });
    expect(JSON.stringify(rule)).not.toContain("BigInt");
    expect(() => JSON.stringify(offer)).not.toThrow();
  });
});
