import { eq } from "drizzle-orm";
import { ledgerEntry } from "../schema/payments.js";
import {
  getInternalTransaction,
  type DatabaseTransaction,
} from "../transaction.js";
import { persistWriteEffects, type WriteEffects } from "./effects.js";

export type NewLedgerEntry = typeof ledgerEntry.$inferInsert;

export function ledgerRepo(db: DatabaseTransaction) {
  const executor = getInternalTransaction(db);
  return {
    async append(entry: NewLedgerEntry, effects: WriteEffects) {
      const [inserted] = await executor
        .insert(ledgerEntry)
        .values(entry)
        .onConflictDoNothing({ target: ledgerEntry.postingKey })
        .returning();
      if (inserted !== undefined) {
        await persistWriteEffects(db, effects);
        return inserted;
      }

      const [existing] = await executor
        .select()
        .from(ledgerEntry)
        .where(eq(ledgerEntry.postingKey, entry.postingKey))
        .limit(1);
      if (existing === undefined) {
        throw new Error("LEDGER_ENTRY_DEDUPLICATION_FAILED");
      }
      return existing;
    },
  };
}
