import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    exclude: [
      "dist/**",
      "../customer-web/**",
      "../staff-web/**",
      "../worker/**",
      "../../test/**",
    ],
    fileParallelism: false,
  },
});
