import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import type { Database } from "./client.js";
import type * as schema from "./schema/index.js";

export type DatabaseTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type DatabaseExecutor = Pick<
  DatabaseTransaction,
  "delete" | "execute" | "insert" | "select" | "update"
>;

export async function withTransaction<T>(
  db: Database,
  operation: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return db.transaction(operation);
}
