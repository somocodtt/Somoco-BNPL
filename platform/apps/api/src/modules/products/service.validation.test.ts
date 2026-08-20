import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { canonicalizeJson } from "@somo/domain/src/index.js";
import { createProductService } from "./service.js";

const disclosureContent = { version: "test-disclosure-v1", body: "Synthetic test disclosure" };
const disclosureHash = createHash("sha256")
  .update(canonicalizeJson({ version: "test-disclosure-v1", content: disclosureContent }))
  .digest("hex");

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
  disclosureContent,
  disclosureHash,
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

  it("requires versioned disclosure content and its exact hash", async () => {
    const service = createProductService({ database: undefined as never });
    await expect(
      service.createRuleVersion({ ...valid, disclosureContent: undefined }),
    ).rejects.toMatchObject({ code: "DISCLOSURE_REQUIRED" });
    await expect(
      service.createRuleVersion({ ...valid, disclosureHash: "0".repeat(64) }),
    ).rejects.toMatchObject({ code: "DISCLOSURE_INVALID" });
  });
});
