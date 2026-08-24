import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  globalSetup: "./test/e2e/global-setup.ts",
  use: {
    baseURL: "http://127.0.0.1:4178",
    channel: "chrome",
  },
});
