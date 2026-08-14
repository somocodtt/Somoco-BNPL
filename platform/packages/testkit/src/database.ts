import { Pool } from "pg";

export function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error(
      "TEST_DATABASE_URL is required for database integration tests",
    );
  }
  assertDisposableTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

export async function resetTestDatabase(
  connectionString: string,
): Promise<void> {
  const configuredUrl = requireTestDatabaseUrl();
  if (connectionString !== configuredUrl) {
    throw new Error("Reset target must exactly match TEST_DATABASE_URL");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("drop schema if exists public cascade");
    await pool.query("drop schema if exists privacy cascade");
    await pool.query("drop schema if exists drizzle cascade");
    await pool.query("create schema public");
  } finally {
    await pool.end();
  }
}

function assertDisposableTestDatabaseUrl(connectionString: string): void {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (!databaseName.toLowerCase().endsWith("_test")) {
    throw new Error(
      "TEST_DATABASE_URL must name a disposable test database ending in _test",
    );
  }
}
