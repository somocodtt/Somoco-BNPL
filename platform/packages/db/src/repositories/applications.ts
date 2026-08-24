import type { ApplicationStatus } from "@somo/domain/src/application-state.js";
import { and, eq } from "drizzle-orm";
import { application } from "../schema/applications.js";
import {
  getInternalTransaction,
  type DatabaseTransaction,
} from "../transaction.js";
import { persistWriteEffects, type WriteEffects } from "./effects.js";

export type NewApplication = typeof application.$inferInsert;

export function applicationRepo(db: DatabaseTransaction) {
  const executor = getInternalTransaction(db);
  return {
    async insert(input: NewApplication, effects: WriteEffects) {
      const [inserted] = await executor
        .insert(application)
        .values(input)
        .returning();
      if (inserted === undefined) {
        throw new Error("APPLICATION_INSERT_FAILED");
      }
      await persistWriteEffects(db, effects);
      return inserted;
    },

    async findById(id: string) {
      const [record] = await executor
        .select()
        .from(application)
        .where(eq(application.id, id))
        .limit(1);
      return record;
    },

    async updateStatus(
      id: string,
      expectedVersion: number,
      status: ApplicationStatus,
      effects: WriteEffects,
      updatedAt = new Date(),
    ) {
      const [updated] = await executor
        .update(application)
        .set({
          status,
          updatedAt,
          version: expectedVersion + 1,
        })
        .where(
          and(eq(application.id, id), eq(application.version, expectedVersion)),
        )
        .returning();

      if (updated === undefined) {
        throw new Error("OPTIMISTIC_LOCK_FAILED");
      }
      await persistWriteEffects(db, effects);
      return updated;
    },
  };
}
