import { defineConfig } from "drizzle-kit";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required for test migrations");
}

let parsedDatabaseUrl: URL;
try {
  parsedDatabaseUrl = new URL(databaseUrl);
} catch {
  throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
}

if (!["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol)) {
  throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
}

const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
if (!databaseName.toLowerCase().endsWith("_test")) {
  throw new Error(
    "TEST_DATABASE_URL must name a disposable test database ending in _test",
  );
}

export default defineConfig({
  dialect: "postgresql",
  dbCredentials: { url: databaseUrl },
  out: "./drizzle",
  schema: "./src/schema/index.ts",
  strict: true,
  verbose: true,
});
