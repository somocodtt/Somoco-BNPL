import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalizeJson,
  FinanceApprovalGate,
  hashWorkedExample,
  type WorkedExampleFixture,
} from "@somo/domain/src/index.js";
import type { FinancingRuleRecord } from "@somo/db";
import { ruleGateStatus } from "./service.js";

const fixtureUnsigned = {
  schemaVersion: 1 as const,
  fixtureId: "task-9-gate-status",
  method: "FLAT_MARKUP" as const,
  frequency: "MONTHLY" as const,
  tenureMonths: 6 as const,
  workedExample: { testOnly: true },
  financeApproved: true,
  complianceApproved: true,
  licencePermitted: true,
  synthetic: true,
};
const fixture: WorkedExampleFixture = {
  ...fixtureUnsigned,
  canonicalHash: hashWorkedExample(fixtureUnsigned),
};
const disclosureVersion = "test-disclosure-v1";
const disclosureContent = {
  version: disclosureVersion,
  body: "Synthetic test disclosure",
};
const disclosureHash = createHash("sha256")
  .update(
    canonicalizeJson({
      version: disclosureVersion,
      content: disclosureContent,
    }),
  )
  .digest("hex");

describe("financing rule gate status", () => {
  it("opens the same rule shape that publish returns after computing its gate status", () => {
    expect(
      ruleGateStatus(baseRule(), FinanceApprovalGate.forTesting([fixture])),
    ).toBe("OPEN");
  });

  it.each([[null], [[]], [{ serviceFee: "unapproved" }]])(
    "closes for %s fee policy",
    (permittedFees) => {
      const rule = {
        ...baseRule(),
        permittedFees,
      } as unknown as FinancingRuleRecord;
      expect(
        ruleGateStatus(rule, FinanceApprovalGate.forTesting([fixture])),
      ).toBe("CLOSED");
    },
  );
});

function baseRule(): FinancingRuleRecord {
  return {
    id: "rule-1",
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
    disclosureVersion,
    disclosureContent,
    disclosureHash,
    fixtureHashes: [fixture.canonicalHash],
    licencePermitted: true,
    approved: true,
    requestedBy: "maker-1",
    approvedBy: "checker-1",
    approvedAt: new Date(),
    effectiveFrom: new Date(),
    effectiveUntil: null,
    publishedAt: new Date(),
  };
}
