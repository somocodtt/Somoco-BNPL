import { Pool } from "pg";

export function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error(
      "TEST_DATABASE_URL is required for database integration tests",
    );
  }
  return databaseUrl;
}

export async function resetTestDatabase(
  connectionString: string,
): Promise<void> {
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
