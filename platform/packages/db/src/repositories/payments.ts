import { paymentTransaction } from "../schema/payments.js";
import {
  getInternalTransaction,
  type DatabaseTransaction,
} from "../transaction.js";
import { persistWriteEffects, type WriteEffects } from "./effects.js";

export type NewPaymentTransaction = typeof paymentTransaction.$inferInsert;

export function paymentRepo(db: DatabaseTransaction) {
  const executor = getInternalTransaction(db);
  return {
    async insert(input: NewPaymentTransaction, effects: WriteEffects) {
      const [inserted] = await executor
        .insert(paymentTransaction)
        .values(input)
        .returning();
      if (inserted === undefined) {
        throw new Error("PAYMENT_TRANSACTION_INSERT_FAILED");
      }
      await persistWriteEffects(db, effects);
      return inserted;
    },
  };
}
