import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
}

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  out: "./drizzle",
  schema: "./src/schema/index.ts",
  strict: true,
  verbose: true,
});
