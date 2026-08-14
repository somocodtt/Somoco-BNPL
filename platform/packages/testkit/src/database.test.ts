import { afterEach, describe, expect, it } from "vitest";
import { requireTestDatabaseUrl, resetTestDatabase } from "./database.js";

const disposableUrl = "postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test";
const originalTestDatabaseUrl = process.env.TEST_DATABASE_URL;

afterEach(() => {
  if (originalTestDatabaseUrl === undefined) {
    delete process.env.TEST_DATABASE_URL;
  } else {
    process.env.TEST_DATABASE_URL = originalTestDatabaseUrl;
  }
});

describe("test database safety", () => {
  it("fails before connecting when TEST_DATABASE_URL is absent", async () => {
    delete process.env.TEST_DATABASE_URL;

    expect(() => requireTestDatabaseUrl()).toThrow(
      "TEST_DATABASE_URL is required",
    );
    await expect(
      resetTestDatabase("postgresql://user@127.0.0.1:1/production"),
    ).rejects.toThrow("TEST_DATABASE_URL is required");
  });

  it("rejects a reset target that differs from TEST_DATABASE_URL", async () => {
    process.env.TEST_DATABASE_URL = disposableUrl;

    await expect(
      resetTestDatabase("postgresql://user@127.0.0.1:1/production"),
    ).rejects.toThrow("Reset target must exactly match TEST_DATABASE_URL");
  });

  it("rejects a TEST_DATABASE_URL without an explicit test database name", async () => {
    process.env.TEST_DATABASE_URL = "postgresql://user@127.0.0.1:1/somo_bnpl";

    await expect(
      resetTestDatabase(process.env.TEST_DATABASE_URL),
    ).rejects.toThrow("TEST_DATABASE_URL must name a disposable test database");
  });
});
