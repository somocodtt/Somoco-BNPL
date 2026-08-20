import { describe, expect, it } from "vitest";
import { createProductService } from "./service.js";

const actor = {
  kind: "staff" as const,
  staffUserId: "00000000-0000-0000-0000-000000000001",
  roles: ["PRODUCT_ADMIN" as const],
  sessionId: "00000000-0000-0000-0000-000000000002",
};

const valid = {
  productId: "00000000-0000-0000-0000-000000000003",
  versionNumber: 1,
  sellingPriceMinor: "100000",
  minimumDepositMinor: "30000",
  method: "FLAT_MARKUP" as const,
  rateBasisPoints: 1200,
  allowedTenuresMonths: [6],
  repaymentFrequencies: ["MONTHLY"] as const,
  disclosureVersion: "test-disclosure-v1",
  permittedFees: {},
  actor,
  requestId: "00000000-0000-0000-0000-000000000004",
};

describe("product financing validation", () => {
  it("rejects a rate above the domain maximum before persistence", async () => {
    const service = createProductService({ database: undefined as never });
    await expect(
      service.createRuleVersion({ ...valid, rateBasisPoints: 1_000_001 }),
    ).rejects.toMatchObject({ code: "RATE_INVALID" });
  });

  it("requires a disclosure version and approved structured fees", async () => {
    const service = createProductService({ database: undefined as never });
    await expect(
      service.createRuleVersion({ ...valid, disclosureVersion: undefined }),
    ).rejects.toMatchObject({ code: "DISCLOSURE_REQUIRED" });
    await expect(
      service.createRuleVersion({ ...valid, permittedFees: { serviceFee: "invented" } }),
    ).rejects.toMatchObject({ code: "FEES_NOT_APPROVED" });
  });
});
