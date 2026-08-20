import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const customerDependencies = fileURLToPath(
  new URL("../customer-web/node_modules", import.meta.url),
);

export default defineConfig({
  build: {
    sourcemap: true,
  },
  resolve: {
    alias: {
      react: `${customerDependencies}/react`,
      "react-dom": `${customerDependencies}/react-dom`,
      "@testing-library": `${customerDependencies}/@testing-library`,
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
