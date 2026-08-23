import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema/index.js";

const databaseCapability = Symbol("somo.database");

export interface Database {
  readonly [databaseCapability]: true;
}

export type InternalDatabase = NodePgDatabase<typeof schema>;

const databaseExecutors = new WeakMap<Database, InternalDatabase>();

export interface DatabaseConnection {
  db: Database;
  close: () => Promise<void>;
}

export function createDatabase(connectionString: string): DatabaseConnection {
  const pool = new Pool({ connectionString });
  const executor = drizzle(pool, { schema });
  const db = Object.freeze({ [databaseCapability]: true as const });
  databaseExecutors.set(db, executor);

  return {
    db,
    close: async () => {
      databaseExecutors.delete(db);
      await pool.end();
    },
  };
}

export function getInternalDatabase(db: Database): InternalDatabase {
  const executor = databaseExecutors.get(db);
  if (executor === undefined) {
    throw new Error("DATABASE_CAPABILITY_INVALID");
  }
  return executor;
}

export async function probeDatabase(db: Database): Promise<boolean> {
  try {
    await getInternalDatabase(db).execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}
