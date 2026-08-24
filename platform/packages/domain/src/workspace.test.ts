import { describe, expect, it } from "vitest";
import { packageBoundary } from "./workspace.js";

describe("domain package boundary", () => {
  it("contains no framework dependency", () => {
    expect(packageBoundary()).toEqual({ frameworkFree: true });
  });
});
