import { describe, expect, it } from "vitest";
import type { Database } from "@somo/db";
import { assertWorkerDatabaseReady } from "../src/main.js";

describe("worker startup database gate", () => {
  it("fails before work when the database probe is down", async () => {
    await expect(
      assertWorkerDatabaseReady({} as Database, async () => false),
    ).rejects.toThrow("WORKER_DATABASE_NOT_READY");
  });

  it("allows work only after a successful database probe", async () => {
    await expect(
      assertWorkerDatabaseReady({} as Database, async () => true),
    ).resolves.toBeUndefined();
  });
});
