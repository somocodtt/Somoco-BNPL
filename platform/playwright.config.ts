import { defineConfig } from "./apps/customer-web/node_modules/@playwright/test/index.mjs";

export default defineConfig({
  testDir: "./test/e2e",
  // The four adverse entry points are Vitest real-app HTTP specs; the browser
  // project runs only the actual customer UI route below.
  testMatch: "pilot-happy-path.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  webServer: {
    command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4178",
    cwd: "apps/customer-web",
    url: "http://127.0.0.1:4178",
    // Always launch the checked-out customer app; a pre-existing process on
    // the fixed test port is not evidence for this checkout.
    reuseExistingServer: false,
    timeout: 120_000,
  },
  use: {
    baseURL: "http://127.0.0.1:4178",
    channel: "chrome",
  },
});
