import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    fileParallelism: false,
    include: [
      "apps/api/test/task15-controlled-pilot.e2e.test.ts",
      "test/e2e/information-request.spec.ts",
      "test/e2e/payment-replay.spec.ts",
      "test/e2e/recovery-control.spec.ts",
      "test/e2e/ownership-transfer.spec.ts",
    ],
  },
});
