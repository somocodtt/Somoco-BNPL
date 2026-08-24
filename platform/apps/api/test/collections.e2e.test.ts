import { describe, expect, it } from "vitest";
import { createCollectionsService } from "../src/modules/collections/service.js";
import { createSettlementService } from "../src/modules/contracts/settlement-service.js";

describe("collections and settlement boundaries", () => {
  it("exposes no automatic recovery or vehicle-control capability", () => {
    expect("immobilize" in createCollectionsService).toBe(false);
    expect("seize" in createCollectionsService).toBe(false);
    expect("remoteCommand" in createCollectionsService).toBe(false);
    expect("immobilize" in createSettlementService).toBe(false);
  });
});
