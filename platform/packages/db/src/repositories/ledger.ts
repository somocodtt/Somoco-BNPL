import { ledgerEntry } from "../schema/payments.js";
import type { DatabaseExecutor } from "../transaction.js";

export type NewLedgerEntry = typeof ledgerEntry.$inferInsert;

export function ledgerRepo(db: DatabaseExecutor) {
  return {
    async append(entry: NewLedgerEntry) {
      const [inserted] = await db.insert(ledgerEntry).values(entry).returning();
      if (inserted === undefined) {
        throw new Error("LEDGER_ENTRY_APPEND_FAILED");
      }
      return inserted;
    },
  };
}
