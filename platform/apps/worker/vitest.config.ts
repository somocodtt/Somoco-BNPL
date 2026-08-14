import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: {
      "@somo/integrations/simulators": fileURLToPath(
        new URL(
          "../../packages/integrations/src/simulators/index.ts",
          import.meta.url,
        ),
      ),
      "@somo/db": fileURLToPath(
        new URL("../../packages/db/src/index.ts", import.meta.url),
      ),
      "@somo/integrations": fileURLToPath(
        new URL("../../packages/integrations/src/index.ts", import.meta.url),
      ),
      "@somo/testkit": fileURLToPath(
        new URL("../../packages/testkit/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
  },
});
