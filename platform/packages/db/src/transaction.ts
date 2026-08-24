import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgQueryResultHKT } from "drizzle-orm/node-postgres";
import type { PgTransaction } from "drizzle-orm/pg-core";
import {
  getInternalDatabase,
  type Database,
  type InternalDatabase,
} from "./client.js";
import type * as schema from "./schema/index.js";

const transactionCapability = Symbol("somo.database-transaction");

export interface DatabaseTransaction {
  readonly [transactionCapability]: true;
}

export type InternalDatabaseTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

export type InternalDatabaseExecutor = Pick<
  InternalDatabaseTransaction,
  "delete" | "execute" | "insert" | "select" | "update"
>;

const transactionExecutors = new WeakMap<
  DatabaseTransaction,
  InternalDatabaseTransaction
>();

export async function withTransaction<T>(
  db: Database,
  operation: (tx: DatabaseTransaction) => Promise<T>,
): Promise<T> {
  return getInternalDatabase(db).transaction(async (executor) => {
    const tx = Object.freeze({ [transactionCapability]: true as const });
    transactionExecutors.set(tx, executor);
    try {
      return await operation(tx);
    } finally {
      transactionExecutors.delete(tx);
    }
  });
}

export function getInternalTransaction(
  tx: DatabaseTransaction,
): InternalDatabaseTransaction {
  const executor = transactionExecutors.get(tx);
  if (executor === undefined) {
    throw new Error("DATABASE_TRANSACTION_CAPABILITY_INVALID");
  }
  return executor;
}

export function getInternalExecutor(
  capability: Database | DatabaseTransaction,
): InternalDatabase | InternalDatabaseTransaction {
  if (transactionExecutors.has(capability as DatabaseTransaction)) {
    return getInternalTransaction(capability as DatabaseTransaction);
  }
  return getInternalDatabase(capability as Database);
}
