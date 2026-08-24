import { defineConfig } from "vitest/config";

export default defineConfig({
  build: {
    sourcemap: true,
    rollupOptions: {
      input: { app: "index.html", "service-worker": "src/service-worker.ts" },
      output: {
        hashCharacters: "hex",
        entryFileNames: (chunk) =>
          chunk.name === "service-worker"
            ? "service-worker.js"
            : "assets/[name].[hash].js",
        chunkFileNames: "assets/[name].[hash].js",
        assetFileNames: "assets/[name].[hash][extname]",
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    restoreMocks: true,
  },
});
