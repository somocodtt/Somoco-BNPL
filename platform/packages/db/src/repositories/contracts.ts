import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { ownershipTransfer } from "../schema/contracts.js";
import { withTransaction } from "../transaction.js";
import { persistWriteEffects, type WriteEffects } from "./effects.js";

export interface CompleteOwnershipTransferCommand {
  id: string;
  expectedVersion: number;
  evidence: Record<string, unknown>;
  approvedBy?: string;
  transferredAt: Date;
  effects: WriteEffects;
}

export async function completeOwnershipTransfer(
  db: Database,
  command: CompleteOwnershipTransferCommand,
) {
  return withTransaction(db, async (tx) => {
    const locked = await tx.execute<{
      version: number;
      contract_status: string;
      outstanding_balance_minor_units: string;
    }>(sql`
      select transfer.version,
             agreement.status as contract_status,
             agreement.outstanding_balance_minor_units
      from ownership_transfer as transfer
      join contract as agreement on agreement.id = transfer.contract_id
      where transfer.id = ${command.id}
      for update of transfer, agreement
    `);
    const record = locked.rows[0];
    if (record === undefined) {
      throw new Error("OWNERSHIP_TRANSFER_NOT_FOUND");
    }
    if (record.version !== command.expectedVersion) {
      throw new Error("OPTIMISTIC_LOCK_FAILED");
    }
    if (
      record.contract_status !== "SETTLED" ||
      BigInt(record.outstanding_balance_minor_units) !== 0n
    ) {
      throw new Error("CONTRACT_NOT_SETTLED");
    }

    const [updated] = await tx
      .update(ownershipTransfer)
      .set({
        status: "COMPLETED",
        evidence: command.evidence,
        approvedBy: command.approvedBy,
        transferredAt: command.transferredAt,
        updatedAt: command.transferredAt,
        version: command.expectedVersion + 1,
      })
      .where(
        and(
          eq(ownershipTransfer.id, command.id),
          eq(ownershipTransfer.version, command.expectedVersion),
        ),
      )
      .returning();
    if (updated === undefined) {
      throw new Error("OPTIMISTIC_LOCK_FAILED");
    }

    await persistWriteEffects(tx, command.effects);
    return updated;
  });
}
