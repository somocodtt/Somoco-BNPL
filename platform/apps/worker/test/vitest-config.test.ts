import { describe, expect, it } from "vitest";
import workerConfig from "../vitest.config.js";

describe("worker database test isolation", () => {
  it("disables file-level parallelism for the shared disposable database", () => {
    expect(workerConfig.test?.fileParallelism).toBe(false);
  });
});
