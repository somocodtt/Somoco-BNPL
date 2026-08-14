import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applicationBuilder,
  auditBuilder,
  inboxBuilder,
  outboxBuilder,
} from "../../testkit/src/builders.js";
import { resetTestDatabase } from "../../testkit/src/database.js";
import { createDatabase, type Database } from "./client.js";
import { receiveInboxMessage } from "./inbox.js";
import { claimOutboxBatch, enqueueOutbox } from "./outbox.js";
import { applicationRepo } from "./repositories/applications.js";
import { appendAuditEvent } from "./repositories/audit.js";
import { auditEvent } from "./schema/audit.js";
import { paymentTransaction } from "./schema/payments.js";
import { person } from "./schema/privacy.js";
import { migrateDatabase } from "./schema/migration.js";
import { withTransaction } from "./transaction.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error(
    "TEST_DATABASE_URL is required for database integration tests",
  );
}

describe("PostgreSQL persistence", () => {
  let db: Database;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ db, close } = createDatabase(databaseUrl));
  });

  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(db);
  });

  afterAll(async () => {
    await close();
  });

  it("rejects an application whose person does not exist", async () => {
    await expect(
      applicationRepo(db).insert(
        applicationBuilder({ applicantPersonId: randomUUID() }),
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("returns the existing inbox record for a duplicate provider event", async () => {
    const event = inboxBuilder({ providerEventId: "evt-1001" });

    const first = await receiveInboxMessage(db, event);
    const duplicate = await receiveInboxMessage(db, event);

    expect(duplicate.id).toBe(first.id);
    expect(await countRows(db, "inbox_message")).toBe(1);
  });

  it("commits aggregate, audit, and outbox atomically", async () => {
    const personId = await insertPerson(db);
    const applicationId = randomUUID();

    await withTransaction(db, async (tx) => {
      await applicationRepo(tx).insert(
        applicationBuilder({
          id: applicationId,
          applicantPersonId: personId,
        }),
      );
      await appendAuditEvent(tx, auditBuilder({ aggregateId: applicationId }));
      await enqueueOutbox(tx, outboxBuilder({ aggregateId: applicationId }));
    });

    expect(await countRows(db, "application")).toBe(1);
    expect(await countRows(db, "audit_event")).toBe(1);
    expect(await countRows(db, "outbox_message")).toBe(1);
  });

  it("rolls back aggregate, audit, and outbox together", async () => {
    const personId = await insertPerson(db);
    const applicationId = randomUUID();

    await expect(
      withTransaction(db, async (tx) => {
        await applicationRepo(tx).insert(
          applicationBuilder({
            id: applicationId,
            applicantPersonId: personId,
          }),
        );
        await appendAuditEvent(
          tx,
          auditBuilder({ aggregateId: applicationId }),
        );
        await enqueueOutbox(tx, outboxBuilder({ aggregateId: applicationId }));
        throw new Error("FORCE_ROLLBACK");
      }),
    ).rejects.toThrow("FORCE_ROLLBACK");

    expect(await countRows(db, "application")).toBe(0);
    expect(await countRows(db, "audit_event")).toBe(0);
    expect(await countRows(db, "outbox_message")).toBe(0);
  });

  it("rejects stale optimistic aggregate updates", async () => {
    const personId = await insertPerson(db);
    const inserted = await applicationRepo(db).insert(
      applicationBuilder({ applicantPersonId: personId }),
    );

    const updated = await applicationRepo(db).updateStatus(
      inserted.id,
      1,
      "AWAITING_GUARANTOR",
    );
    expect(updated.version).toBe(2);

    await expect(
      applicationRepo(db).updateStatus(inserted.id, 1, "READY_TO_SUBMIT"),
    ).rejects.toThrow("OPTIMISTIC_LOCK_FAILED");
  });

  it("uses skip-locked claims so concurrent workers receive disjoint messages", async () => {
    const message = await enqueueOutbox(db, outboxBuilder());

    const [workerOne, workerTwo] = await Promise.all([
      claimOutboxBatch(db, { workerId: "worker-one", limit: 1 }),
      claimOutboxBatch(db, { workerId: "worker-two", limit: 1 }),
    ]);

    const claimed = [...workerOne, ...workerTwo];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(message.id);
    expect(claimed[0]?.attempts).toBe(1);
  });

  it("enforces provider transaction idempotency and nonnegative payment amounts", async () => {
    const payment = {
      provider: "SOMOCO_PAYMENTS",
      providerTransactionId: "txn-1001",
      payerReference: "+233201234567",
      amountMinorUnits: 12_500n,
      status: "RECEIVED" as const,
      providerPayload: { eventId: "evt-1001" },
      occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    };

    await db.insert(paymentTransaction).values(payment);
    await expect(
      db.insert(paymentTransaction).values(payment),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    await expect(
      db.insert(paymentTransaction).values({
        ...payment,
        providerTransactionId: "txn-1002",
        amountMinorUnits: -1n,
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("blocks audit mutation and installs append-only controls for audit and ledger", async () => {
    const event = await appendAuditEvent(db, auditBuilder());

    await expect(
      db.execute(
        sql`update ${auditEvent} set action = 'TAMPERED' where id = ${event.id}`,
      ),
    ).rejects.toMatchObject({ cause: { code: "55000" } });

    const controls = await db.execute<{
      table_name: string;
      trigger_name: string;
    }>(sql`
      select distinct event_object_table as table_name, trigger_name
      from information_schema.triggers
      where trigger_name in ('audit_event_append_only', 'ledger_entry_append_only')
      order by trigger_name
    `);
    expect(controls.rows).toEqual([
      {
        table_name: "audit_event",
        trigger_name: "audit_event_append_only",
      },
      {
        table_name: "ledger_entry",
        trigger_name: "ledger_entry_append_only",
      },
    ]);

    const publicGrants = await db.execute<{ count: number }>(sql`
      select count(*)::int as count
      from information_schema.role_table_grants
      where grantee = 'PUBLIC'
        and table_name in ('audit_event', 'ledger_entry')
        and privilege_type in ('UPDATE', 'DELETE')
    `);
    expect(publicGrants.rows[0]?.count).toBe(0);
  });
});

async function insertPerson(db: Database): Promise<string> {
  const record = {
    id: randomUUID(),
    phoneE164: `+2332${randomUUID().replaceAll("-", "").slice(0, 8).replace(/[a-f]/g, "1")}`,
    createdAt: new Date("2026-08-14T12:00:00.000Z"),
    updatedAt: new Date("2026-08-14T12:00:00.000Z"),
  };
  await db.insert(person).values(record);
  return record.id;
}

async function countRows(db: Database, table: string): Promise<number> {
  const result = await db.execute(
    `select count(*)::int as count from ${table}`,
  );
  return Number(result.rows[0]?.count);
}
