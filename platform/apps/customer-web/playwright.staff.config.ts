import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  testMatch: "staff-approval-chain.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  globalSetup: "./test/e2e/staff-approval-global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:4179",
    channel: "chrome",
  },
});
