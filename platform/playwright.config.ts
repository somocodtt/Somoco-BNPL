import { defineConfig } from "./apps/customer-web/node_modules/@playwright/test/index.mjs";

export default defineConfig({
  testDir: "./test/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  use: {
    baseURL: "https://pilot.test",
    channel: "chrome",
  },
});
