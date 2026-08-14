import type { ApplicationStatus } from "@somo/domain/src/application-state.js";
import { and, eq } from "drizzle-orm";
import { application } from "../schema/applications.js";
import type { DatabaseExecutor } from "../transaction.js";

export type NewApplication = typeof application.$inferInsert;

export function applicationRepo(db: DatabaseExecutor) {
  return {
    async insert(input: NewApplication) {
      const [inserted] = await db.insert(application).values(input).returning();
      if (inserted === undefined) {
        throw new Error("APPLICATION_INSERT_FAILED");
      }
      return inserted;
    },

    async findById(id: string) {
      const [record] = await db
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
      updatedAt = new Date(),
    ) {
      const [updated] = await db
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
      return updated;
    },
  };
}
