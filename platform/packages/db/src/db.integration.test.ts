import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  applicationBuilder,
  auditBuilder,
  inboxBuilder,
  outboxBuilder,
} from "../../testkit/src/builders.js";
import { resetTestDatabase } from "../../testkit/src/database.js";
import {
  createDatabase,
  getInternalDatabase,
  type Database,
  type InternalDatabase,
} from "./client.js";
import { completeInboxMessage, receiveInboxMessage } from "./inbox.js";
import {
  claimOutboxBatch,
  enqueueOutbox,
  listOutboxAttempts,
} from "./outbox.js";
import { applicationRepo } from "./repositories/applications.js";
import { appendAuditEvent } from "./repositories/audit.js";
import { completeOwnershipTransfer } from "./repositories/contracts.js";
import { ledgerRepo } from "./repositories/ledger.js";
import { paymentRepo } from "./repositories/payments.js";
import { application } from "./schema/applications.js";
import { registrationRecord, vehicleUnit } from "./schema/assets.js";
import { auditEvent } from "./schema/audit.js";
import {
  contract,
  installment,
  ownershipTransfer,
  repaymentSchedule,
} from "./schema/contracts.js";
import { offer, offerVersion } from "./schema/offers.js";
import { ledgerEntry, paymentTransaction } from "./schema/payments.js";
import { person } from "./schema/privacy.js";
import { migrateDatabase } from "./schema/migration.js";
import {
  financingRuleVersion,
  product,
  vehicleModel,
} from "./schema/products.js";
import { withTransaction } from "./transaction.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

if (databaseUrl === undefined) {
  throw new Error(
    "TEST_DATABASE_URL is required for database integration tests",
  );
}

describe("PostgreSQL persistence", () => {
  let database: Database;
  let db: InternalDatabase;
  let close: () => Promise<void>;

  beforeAll(async () => {
    const connection = createDatabase(databaseUrl);
    database = connection.db;
    db = getInternalDatabase(database);
    close = connection.close;
  });

  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(database);
  });

  afterAll(async () => {
    await close();
  });

  it("applies the complete migration journal once and is repeat-safe", async () => {
    const before = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `);

    await migrateDatabase(database);
    await migrateDatabase(database);

    const after = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `);
    expect(before.rows[0]?.count).toBe(9);
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it("rejects an application whose person does not exist", async () => {
    await expect(
      withTransaction(database, async (tx) =>
        applicationRepo(tx).insert(
          applicationBuilder({ applicantPersonId: randomUUID() }),
          writeEffects(randomUUID()),
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("gives only one concurrent inbox receiver ownership of processing", async () => {
    const event = inboxBuilder({ providerEventId: "evt-1001" });

    const [first, duplicate] = await Promise.all([
      receiveInboxMessage(database, event),
      receiveInboxMessage(database, event),
    ]);
    const owner = first.inserted ? first : duplicate;
    const observer = first.inserted ? duplicate : first;

    expect(duplicate.id).toBe(first.id);
    expect([first.inserted, duplicate.inserted].sort()).toEqual([false, true]);
    expect(owner.processingToken).toEqual(expect.any(String));
    expect(observer.processingToken).toBeNull();
    expect(await countRows(db, "inbox_message")).toBe(1);

    await completeInboxMessage(database, owner.id, owner.processingToken!, {
      accepted: true,
    });
    await expect(
      completeInboxMessage(database, owner.id, owner.processingToken!, {
        accepted: false,
      }),
    ).rejects.toThrow("INBOX_COMPLETION_NOT_OWNED");
  });

  it("commits aggregate, audit, and outbox atomically", async () => {
    const personId = await insertPerson(db);
    const applicationId = randomUUID();

    await withTransaction(database, async (tx) => {
      await applicationRepo(tx).insert(
        applicationBuilder({
          id: applicationId,
          applicantPersonId: personId,
        }),
        writeEffects(applicationId),
      );
    });

    expect(await countRows(db, "application")).toBe(1);
    expect(await countRows(db, "audit_event")).toBe(1);
    expect(await countRows(db, "outbox_message")).toBe(1);
  });

  it("rolls back aggregate, audit, and outbox together", async () => {
    const personId = await insertPerson(db);
    const applicationId = randomUUID();

    await expect(
      withTransaction(database, async (tx) => {
        await applicationRepo(tx).insert(
          applicationBuilder({
            id: applicationId,
            applicantPersonId: personId,
          }),
          writeEffects(applicationId),
        );
        throw new Error("FORCE_ROLLBACK");
      }),
    ).rejects.toThrow("FORCE_ROLLBACK");

    expect(await countRows(db, "application")).toBe(0);
    expect(await countRows(db, "audit_event")).toBe(0);
    expect(await countRows(db, "outbox_message")).toBe(0);
  });

  it("rejects stale optimistic aggregate updates", async () => {
    const personId = await insertPerson(db);
    const applicationId = randomUUID();
    const inserted = await withTransaction(database, (tx) =>
      applicationRepo(tx).insert(
        applicationBuilder({
          id: applicationId,
          applicantPersonId: personId,
        }),
        writeEffects(applicationId),
      ),
    );

    const updated = await withTransaction(database, (tx) =>
      applicationRepo(tx).updateStatus(
        inserted.id,
        1,
        "AWAITING_GUARANTOR",
        writeEffects(applicationId, "APPLICATION_STATUS_CHANGED"),
      ),
    );
    expect(updated.version).toBe(2);
    expect(await countRows(db, "audit_event")).toBe(2);
    expect(await countRows(db, "outbox_message")).toBe(2);

    await expect(
      withTransaction(database, (tx) =>
        applicationRepo(tx).updateStatus(
          inserted.id,
          1,
          "READY_TO_SUBMIT",
          writeEffects(applicationId, "APPLICATION_STATUS_CHANGED"),
        ),
      ),
    ).rejects.toThrow("OPTIMISTIC_LOCK_FAILED");
  });

  it("uses skip-locked claims so concurrent workers receive disjoint messages", async () => {
    const message = await enqueueOutbox(database, outboxBuilder());

    const [workerOne, workerTwo] = await Promise.all([
      claimOutboxBatch(database, { workerId: "worker-one", limit: 1 }),
      claimOutboxBatch(database, { workerId: "worker-two", limit: 1 }),
    ]);

    const claimed = [...workerOne, ...workerTwo];
    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.id).toBe(message.id);
    expect(claimed[0]?.attempts).toBe(1);
  });

  it("enforces provider transaction idempotency and nonnegative payment amounts", async () => {
    const payment = {
      provider: "SOMOCO_PAYMENTS",
      channel: "MOBILE_MONEY",
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
    const event = await appendAuditEvent(database, auditBuilder());

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

  it("grants a non-owner runtime role no audit or ledger mutation privileges", async () => {
    const role = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from pg_roles where rolname = 'somo_runtime'
    `);
    expect(role.rows[0]?.count).toBe(1);

    const privileges = await db.execute<{
      audit_select: boolean;
      audit_insert: boolean;
      audit_update: boolean;
      audit_delete: boolean;
      ledger_update: boolean;
      ledger_delete: boolean;
    }>(sql`
      select
        has_table_privilege('somo_runtime', 'audit_event', 'SELECT') as audit_select,
        has_table_privilege('somo_runtime', 'audit_event', 'INSERT') as audit_insert,
        has_table_privilege('somo_runtime', 'audit_event', 'UPDATE') as audit_update,
        has_table_privilege('somo_runtime', 'audit_event', 'DELETE') as audit_delete,
        has_table_privilege('somo_runtime', 'ledger_entry', 'UPDATE') as ledger_update,
        has_table_privilege('somo_runtime', 'ledger_entry', 'DELETE') as ledger_delete
    `);
    expect(privileges.rows[0]).toEqual({
      audit_select: true,
      audit_insert: true,
      audit_update: false,
      audit_delete: false,
      ledger_update: false,
      ledger_delete: false,
    });
  });

  it("records a payment with audit and outbox in one transaction", async () => {
    const graph = await insertFinancialGraph(db, { includePayment: false });
    const paymentId = randomUUID();

    await withTransaction(database, (tx) =>
      paymentRepo(tx).insert(
        {
          id: paymentId,
          provider: "SOMOCO_PAYMENTS",
          channel: "USSD",
          providerTransactionId: "ussd-atomic-1001",
          contractId: graph.contractId,
          payerReference: "*711#",
          amountMinorUnits: 1_000n,
          providerPayload: {},
          occurredAt: new Date("2026-08-14T12:00:00.000Z"),
        },
        writeEffects(paymentId, "PAYMENT_RECEIVED"),
      ),
    );

    expect(await countRows(db, "payment_transaction")).toBe(1);
    expect(await countRows(db, "audit_event")).toBe(1);
    expect(await countRows(db, "outbox_message")).toBe(1);
  });

  it("returns the original ledger allocation for a repeated posting key", async () => {
    const graph = await insertFinancialGraph(db);
    const entryId = randomUUID();
    const entry = {
      id: entryId,
      postingKey: "payment-1001:installment-1:repayment",
      contractId: graph.contractId,
      paymentTransactionId: graph.paymentTransactionId,
      installmentId: graph.installmentIds[0],
      entryType: "REPAYMENT" as const,
      direction: "CREDIT" as const,
      amountMinorUnits: 10_000n,
      balanceAfterMinorUnits: 90_000n,
      occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    };

    const first = await withTransaction(database, (tx) =>
      ledgerRepo(tx).append(entry, writeEffects(entryId, "LEDGER_POSTED")),
    );
    const duplicate = await withTransaction(database, (tx) =>
      ledgerRepo(tx).append(
        { ...entry, id: randomUUID() },
        writeEffects(entryId, "LEDGER_POSTED"),
      ),
    );

    expect(duplicate.id).toBe(first.id);
    expect(await countRows(db, "ledger_entry")).toBe(1);
    expect(await countRows(db, "audit_event")).toBe(1);
    expect(await countRows(db, "outbox_message")).toBe(1);
  });

  it("rejects a ledger allocation whose payment or installment belongs to another contract", async () => {
    const first = await insertFinancialGraph(db);
    const second = await insertFinancialGraph(db);

    await expect(
      db.insert(ledgerEntry).values({
        id: randomUUID(),
        postingKey: "mismatched-allocation",
        contractId: first.contractId,
        paymentTransactionId: second.paymentTransactionId,
        installmentId: second.installmentIds[0],
        entryType: "REPAYMENT",
        direction: "CREDIT",
        amountMinorUnits: 1_000n,
        balanceAfterMinorUnits: 99_000n,
        occurredAt: new Date("2026-08-14T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("rejects payment rails outside Somoco USSD and Mobile Money", async () => {
    await expect(
      db.insert(paymentTransaction).values({
        provider: "CASH",
        channel: "CASH",
        providerTransactionId: "cash-1001",
        payerReference: "cash-office",
        amountMinorUnits: 1_000n,
        providerPayload: {},
        occurredAt: new Date("2026-08-14T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ cause: { code: "22P02" } });
  });

  it("rejects ownership transfer before a contract is settled with zero balance", async () => {
    const graph = await insertFinancialGraph(db, {
      contractStatus: "ACTIVE",
      outstandingBalanceMinorUnits: 100_000n,
    });

    await expect(
      db.insert(ownershipTransfer).values({
        contractId: graph.contractId,
        status: "COMPLETED",
        evidence: { documentId: randomUUID() },
        transferredAt: new Date("2026-08-14T12:00:00.000Z"),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("allows pending and approved ownership workflow before settlement", async () => {
    const graph = await insertFinancialGraph(db, {
      contractStatus: "ACTIVE",
      outstandingBalanceMinorUnits: 100_000n,
    });

    const [pending] = await db
      .insert(ownershipTransfer)
      .values({ contractId: graph.contractId, status: "PENDING" })
      .returning();
    const [approved] = await db
      .update(ownershipTransfer)
      .set({ status: "APPROVED" })
      .where(sql`${ownershipTransfer.id} = ${pending!.id}`)
      .returning();

    expect(approved?.status).toBe("APPROVED");
  });

  it("completes ownership transfer through a locked audited transition", async () => {
    const graph = await insertFinancialGraph(db, {
      contractStatus: "SETTLED",
      outstandingBalanceMinorUnits: 0n,
    });
    const transferId = randomUUID();
    await db.insert(ownershipTransfer).values({
      id: transferId,
      contractId: graph.contractId,
    });

    const completed = await completeOwnershipTransfer(database, {
      id: transferId,
      expectedVersion: 1,
      evidence: { documentId: randomUUID() },
      transferredAt: new Date("2026-08-14T12:00:00.000Z"),
      effects: writeEffects(transferId, "OWNERSHIP_TRANSFER_COMPLETED"),
    });

    expect(completed.status).toBe("COMPLETED");
    expect(completed.version).toBe(2);
    expect(await countRows(db, "audit_event")).toBe(1);
    expect(await countRows(db, "outbox_message")).toBe(1);

    await db.insert(registrationRecord).values({
      vehicleUnitId: graph.vehicleUnitId,
      registrationNumber: "REG-CUSTOMER-1001",
      registeredOwner: "CUSTOMER",
      validFrom: "2026-08-14",
    });
    expect(await countRows(db, "registration_record")).toBe(1);
  });

  it("rejects customer registration before ownership transfer completes", async () => {
    const graph = await insertFinancialGraph(db);

    await expect(
      db.insert(registrationRecord).values({
        vehicleUnitId: graph.vehicleUnitId,
        registrationNumber: "REG-EARLY-1001",
        registeredOwner: "CUSTOMER",
        validFrom: "2026-08-14",
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });

  it("rejects an installment paid amount above its contractual amount", async () => {
    const graph = await insertFinancialGraph(db);

    await expect(
      db
        .update(installment)
        .set({ paidMinorUnits: 100_001n })
        .where(sql`${installment.id} = ${graph.installmentIds[0]}`),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});

describe("populated legacy schema migration", () => {
  let pool: Pool;

  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl, max: 1 });
  });

  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await applyMigrationFile(pool, "0000_worthless_glorian.sql");
  });

  afterAll(async () => {
    await pool.end();
  });

  it("backfills compatible populated rows without changing financial values", async () => {
    const legacy = await insertLegacyFinancialGraph(pool, {
      provider: "SOMOCO_PAYMENTS",
      channel: "MOBILE_MONEY",
      registeredOwner: "SOMOCO",
    });

    await applyMigrationFile(pool, "0001_fresh_talon.sql");

    const upgraded = await pool.query<{
      contract_id: string;
      posting_key: string;
      channel: string;
      installment_amount: string;
      installment_paid: string;
      payment_amount: string;
      ledger_amount: string;
      balance_after_minor_units: string;
    }>(
      `
      select installment.contract_id,
             ledger.posting_key,
             payment.channel,
             installment.amount_minor_units as installment_amount,
             installment.paid_minor_units as installment_paid,
             payment.amount_minor_units as payment_amount,
             ledger.amount_minor_units as ledger_amount,
             ledger.balance_after_minor_units
      from installment
      join ledger_entry as ledger on ledger.installment_id = installment.id
      join payment_transaction as payment on payment.id = ledger.payment_transaction_id
      where installment.id = $1
    `,
      [legacy.installmentId],
    );

    expect(upgraded.rows[0]).toEqual({
      contract_id: legacy.contractId,
      posting_key: `legacy:ledger:${legacy.ledgerEntryId}`,
      channel: "MOBILE_MONEY",
      installment_amount: "100000",
      installment_paid: "10000",
      payment_amount: "10000",
      ledger_amount: "10000",
      balance_after_minor_units: "90000",
    });
  });

  it("fails clearly and atomically for an incompatible legacy provider", async () => {
    await insertLegacyFinancialGraph(pool, {
      provider: "CASH",
      channel: "MOBILE_MONEY",
      registeredOwner: "SOMOCO",
    });

    await expect(
      applyMigrationFile(pool, "0001_fresh_talon.sql"),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("legacy payment provider"),
    });
    await expectLegacySchemaUnchanged(pool);
  });

  it("fails clearly rather than inventing a missing legacy payment channel", async () => {
    await insertLegacyFinancialGraph(pool, {
      provider: "SOMOCO_PAYMENTS",
      registeredOwner: "SOMOCO",
    });

    await expect(
      applyMigrationFile(pool, "0001_fresh_talon.sql"),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("legacy payment channel"),
    });
    await expectLegacySchemaUnchanged(pool);
  });

  it("fails clearly and atomically for an incompatible registration owner", async () => {
    await insertLegacyFinancialGraph(pool, {
      provider: "SOMOCO_PAYMENTS",
      channel: "USSD",
      registeredOwner: "THIRD_PARTY",
    });

    await expect(
      applyMigrationFile(pool, "0001_fresh_talon.sql"),
    ).rejects.toMatchObject({
      code: "23514",
      message: expect.stringContaining("legacy registration owner"),
    });
    await expectLegacySchemaUnchanged(pool);
  });

  it("backfills active 0003 claims as started attempts that can be abandoned and reclaimed", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }
    const messageId = randomUUID();
    const aggregateId = randomUUID();
    await pool.query(
      `
        insert into outbox_message (
          id, topic, aggregate_type, aggregate_id, payload, occurred_at,
          attempts, claimed_by, claimed_at, available_at
        ) values ($1, 'erp.publish', 'contract', $2, '{}', now() - interval '2 hours',
                  1, 'legacy-worker', now() - interval '1 hour', now() - interval '2 hours')
      `,
      [messageId, aggregateId],
    );

    await applyMigrationFile(pool, "0004_tearful_dark_phoenix.sql");
    const connection = createDatabase(databaseUrl);
    try {
      const [reclaimed] = await claimOutboxBatch(connection.db, {
        workerId: "replacement-worker",
        limit: 1,
        claimLeaseMs: 5,
        maxAttempts: 3,
      });

      expect(reclaimed).toMatchObject({ id: messageId, attempts: 2 });
      expect(await listOutboxAttempts(connection.db, messageId)).toMatchObject([
        {
          attemptNumber: 1,
          workerId: "legacy-worker",
          outcome: "ABANDONED",
          failureCode: "OUTBOX_CLAIM_EXPIRED",
        },
        {
          attemptNumber: 2,
          workerId: "replacement-worker",
          outcome: "STARTED",
          failureCode: null,
          finishedAt: null,
        },
      ]);
    } finally {
      await connection.close();
    }
  });

  it("quarantines populated legacy documents while adding bound upload evidence", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }
    const personId = randomUUID();
    const documentId = randomUUID();
    await pool.query(
      `insert into privacy.person (id, phone_e164) values ($1, $2)`,
      [personId, "+233200009901"],
    );
    await pool.query(
      `insert into privacy.document
         (id, person_id, document_type, object_key, sha256, status,
          malware_scanned, metadata, created_at, updated_at)
       values
         ($1, $2, 'GHANA_CARD_FRONT', $3, 'legacy-unverified-digest',
          'ACCEPTED', false, '{"source":"legacy"}'::jsonb,
          '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z')`,
      [documentId, personId, `legacy/${documentId}`],
    );

    await applyMigrationFile(pool, "0006_worthless_marrow.sql");

    const migrated = await pool.query<{
      declared_mime_type: string;
      declared_size_bytes: number;
      upload_ticket_hash: string;
      upload_expires_at: Date;
      sha256: string | null;
      status: string;
      malware_scanned: boolean;
      metadata: Record<string, unknown>;
    }>(
      `select declared_mime_type, declared_size_bytes, upload_ticket_hash,
              upload_expires_at, sha256, status, malware_scanned, metadata
         from privacy.document
        where id = $1`,
      [documentId],
    );
    expect(migrated.rows[0]).toEqual({
      declared_mime_type: "application/octet-stream",
      declared_size_bytes: 1,
      upload_ticket_hash: "0".repeat(64),
      upload_expires_at: new Date("2026-08-14T12:00:00.000Z"),
      sha256: null,
      status: "QUARANTINED",
      malware_scanned: false,
      metadata: {
        source: "legacy",
        legacyUploadEvidence: true,
        migrationReason: "UPLOAD_BINDING_UNAVAILABLE",
      },
    });
  });

  it("safely upgrades populated accepted documents and legacy identity checks in 0007", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }
    const personId = randomUUID();
    const documentId = randomUUID();
    const identityCheckId = randomUUID();
    await pool.query(
      `insert into privacy.person (id, phone_e164) values ($1, $2)`,
      [personId, "+233200009902"],
    );
    await pool.query(
      `insert into privacy.document
         (id, person_id, document_type, object_key, declared_mime_type,
          declared_size_bytes, upload_ticket_hash, upload_expires_at, sha256,
          status, malware_scanned, metadata, created_at, updated_at)
       values ($1, $2, 'GHANA_CARD_FRONT', $3, 'image/png', 68, $4,
               '2026-08-14T12:01:00.000Z', $5, 'ACCEPTED', true,
               '{"source":"pre-immutable"}'::jsonb,
               '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z')`,
      [
        documentId,
        personId,
        `legacy/${documentId}`,
        "0".repeat(64),
        "1".repeat(64),
      ],
    );
    await pool.query(
      `insert into privacy.identity_check
         (id, person_id, provider, provider_reference, status, evidence,
          checked_at, created_at)
       values ($1, $2, 'NIA', 'legacy-provider-reference', 'VERIFIED',
               '{"decision":"MATCH"}'::jsonb,
               '2026-08-14T12:00:00.000Z', '2026-08-14T12:00:00.000Z')`,
      [identityCheckId, personId],
    );

    await applyMigrationFile(pool, "0007_concerned_siren.sql");

    const documentResult = await pool.query<{
      status: string;
      malware_scanned: boolean;
      accepted_object_key: string | null;
      metadata: Record<string, unknown>;
    }>(
      `select status, malware_scanned, accepted_object_key, metadata
         from privacy.document where id = $1`,
      [documentId],
    );
    expect(documentResult.rows[0]).toEqual({
      status: "QUARANTINED",
      malware_scanned: false,
      accepted_object_key: null,
      metadata: {
        source: "pre-immutable",
        legacyAcceptedEvidence: true,
        migrationReason: "IMMUTABLE_OBJECT_IDENTITY_UNAVAILABLE",
      },
    });
    const identityResult = await pool.query<{
      provider_correlation_id: string;
      idempotency_key: string | null;
      consent_evidence_id: string | null;
    }>(
      `select provider_correlation_id, idempotency_key, consent_evidence_id
         from privacy.identity_check where id = $1`,
      [identityCheckId],
    );
    expect(identityResult.rows[0]).toEqual({
      provider_correlation_id: identityCheckId,
      idempotency_key: null,
      consent_evidence_id: null,
    });
  });

  it("adds onboarding controls to a populated 0007 schema without changing existing rows", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }
    const applicantId = randomUUID();
    const guarantorId = randomUUID();
    const applicationId = randomUUID();
    const relationshipId = randomUUID();
    const applicationVersionId = randomUUID();
    await pool.query(
      `insert into privacy.person (id, phone_e164) values ($1, '+233200009903'), ($2, '+233200009904')`,
      [applicantId, guarantorId],
    );
    await pool.query(
      `insert into application (id, applicant_person_id) values ($1, $2)`,
      [applicationId, applicantId],
    );
    await pool.query(
      `insert into guarantor_relationship (id, application_id, guarantor_person_id)
       values ($1, $2, $3)`,
      [relationshipId, applicationId, guarantorId],
    );
    await pool.query(
      `insert into application_version
         (id, application_id, version_number, snapshot, submitted_at)
       values ($1, $2, 1, '{"legacy":true}'::jsonb, '2026-08-14T12:00:00.000Z')`,
      [applicationVersionId, applicationId],
    );

    await applyMigrationFile(pool, "0008_regular_juggernaut.sql");

    const preserved = await pool.query(
      `select gr.id relationship_id, av.snapshot
         from guarantor_relationship gr
         join application_version av on av.application_id = gr.application_id
        where gr.application_id = $1`,
      [applicationId],
    );
    expect(preserved.rows[0]).toEqual({
      relationship_id: relationshipId,
      snapshot: { legacy: true },
    });
    await expect(
      pool.query(
        `update application_version set snapshot = '{}'::jsonb where id = $1`,
        [applicationVersionId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`select count(*)::int from guarantor_invitation`),
    ).resolves.toMatchObject({ rows: [{ count: 0 }] });
  });

  it("fails 0008 closed with actionable remediation when legacy applications have multiple guarantors", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }
    const applicantId = randomUUID();
    const firstGuarantorId = randomUUID();
    const secondGuarantorId = randomUUID();
    const applicationId = randomUUID();
    await pool.query(
      `insert into privacy.person (id, phone_e164)
       values ($1, '+233200009905'), ($2, '+233200009906'), ($3, '+233200009907')`,
      [applicantId, firstGuarantorId, secondGuarantorId],
    );
    await pool.query(
      `insert into application (id, applicant_person_id) values ($1, $2)`,
      [applicationId, applicantId],
    );
    await pool.query(
      `insert into guarantor_relationship
         (id, application_id, guarantor_person_id)
       values ($1, $2, $3), ($4, $2, $5)`,
      [
        randomUUID(),
        applicationId,
        firstGuarantorId,
        randomUUID(),
        secondGuarantorId,
      ],
    );

    await expect(
      applyMigrationFile(pool, "0008_regular_juggernaut.sql"),
    ).rejects.toMatchObject({
      code: "P0001",
      message: expect.stringContaining(
        "MIGRATION_0008_DUPLICATE_GUARANTOR_RELATIONSHIPS",
      ),
      hint: expect.stringContaining(
        "resolve each application to exactly one guarantor_relationship row",
      ),
    });
    await expect(
      pool.query(
        `select count(*)::int count
           from guarantor_relationship where application_id = $1`,
        [applicationId],
      ),
    ).resolves.toMatchObject({ rows: [{ count: 2 }] });
    await expect(
      pool.query(`select to_regclass('public.guarantor_invitation') created`),
    ).resolves.toMatchObject({ rows: [{ created: null }] });
  });
});

function writeEffects(aggregateId: string, action = "APPLICATION_CREATED") {
  return {
    audit: auditBuilder({ aggregateId, action }),
    outbox: outboxBuilder({ aggregateId, topic: action }),
  };
}

interface FinancialGraphOptions {
  contractStatus?: "ACTIVE" | "SETTLED";
  outstandingBalanceMinorUnits?: bigint;
  includePayment?: boolean;
}

async function insertFinancialGraph(
  db: InternalDatabase,
  options: FinancialGraphOptions = {},
) {
  const personId = await insertPerson(db);
  const applicationId = randomUUID();
  const vehicleModelId = randomUUID();
  const productId = randomUUID();
  const ruleId = randomUUID();
  const offerId = randomUUID();
  const offerVersionId = randomUUID();
  const vehicleUnitId = randomUUID();
  const contractId = randomUUID();
  const scheduleId = randomUUID();
  const installmentIds = [randomUUID(), randomUUID()];
  const paymentTransactionId = randomUUID();
  const suffix = randomUUID();

  await db
    .insert(application)
    .values(
      applicationBuilder({ id: applicationId, applicantPersonId: personId }),
    );
  await db.insert(vehicleModel).values({
    id: vehicleModelId,
    manufacturer: `Maker-${suffix}`,
    modelName: "Pilot",
    modelYear: 2026,
  });
  await db.insert(product).values({
    id: productId,
    code: `PRODUCT-${suffix}`,
    name: "Pilot product",
    vehicleModelId,
  });
  await db.insert(financingRuleVersion).values({
    id: ruleId,
    productId,
    versionNumber: 1,
    minimumDepositMinorUnits: 10_000n,
    annualRateBps: "1200",
    allowedTenuresMonths: [12],
    repaymentFrequencies: ["MONTHLY"],
    calculationMethod: "DECLINING_BALANCE",
  });
  await db.insert(offer).values({ id: offerId, applicationId });
  await db.insert(offerVersion).values({
    id: offerVersionId,
    offerId,
    financingRuleVersionId: ruleId,
    versionNumber: 1,
    principalMinorUnits: 100_000n,
    depositMinorUnits: 10_000n,
    totalPayableMinorUnits: 110_000n,
    terms: {},
  });
  await db.insert(vehicleUnit).values({
    id: vehicleUnitId,
    vehicleModelId,
    vin: `VIN-${suffix}`,
    chassisNumber: `CHASSIS-${suffix}`,
  });
  await db.insert(contract).values({
    id: contractId,
    reference: `CONTRACT-${suffix}`,
    applicationId,
    offerVersionId,
    vehicleUnitId,
    status: options.contractStatus ?? "ACTIVE",
    outstandingBalanceMinorUnits:
      options.outstandingBalanceMinorUnits ?? 100_000n,
  });
  await db.insert(repaymentSchedule).values({
    id: scheduleId,
    contractId,
    versionNumber: 1,
    totalMinorUnits: 100_000n,
    firstDueDate: "2026-09-01",
  });
  await db.insert(installment).values([
    {
      id: installmentIds[0]!,
      contractId,
      repaymentScheduleId: scheduleId,
      installmentNumber: 1,
      dueDate: "2026-09-01",
      amountMinorUnits: 50_000n,
    },
    {
      id: installmentIds[1]!,
      contractId,
      repaymentScheduleId: scheduleId,
      installmentNumber: 2,
      dueDate: "2026-10-01",
      amountMinorUnits: 50_000n,
    },
  ]);
  if (options.includePayment !== false) {
    await db.insert(paymentTransaction).values({
      id: paymentTransactionId,
      provider: "SOMOCO_PAYMENTS",
      channel: "MOBILE_MONEY",
      providerTransactionId: `TXN-${suffix}`,
      contractId,
      payerReference: "+233201234567",
      amountMinorUnits: 10_000n,
      providerPayload: {},
      occurredAt: new Date("2026-08-14T12:00:00.000Z"),
    });
  }

  return { contractId, installmentIds, paymentTransactionId, vehicleUnitId };
}

async function insertPerson(db: InternalDatabase): Promise<string> {
  const record = {
    id: randomUUID(),
    phoneE164: `+2332${randomUUID().replaceAll("-", "").slice(0, 8).replace(/[a-f]/g, "1")}`,
    createdAt: new Date("2026-08-14T12:00:00.000Z"),
    updatedAt: new Date("2026-08-14T12:00:00.000Z"),
  };
  await db.insert(person).values(record);
  return record.id;
}

async function countRows(db: InternalDatabase, table: string): Promise<number> {
  const result = await db.execute(
    `select count(*)::int as count from ${table}`,
  );
  return Number(result.rows[0]?.count);
}

const migrationsFolder = fileURLToPath(new URL("../drizzle/", import.meta.url));

async function applyMigrationFile(pool: Pool, filename: string): Promise<void> {
  const migration = await readFile(`${migrationsFolder}${filename}`, "utf8");
  const statements = migration
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

interface LegacyGraphOptions {
  provider: string;
  channel?: "USSD" | "MOBILE_MONEY";
  registeredOwner: string;
}

async function insertLegacyFinancialGraph(
  pool: Pool,
  options: LegacyGraphOptions,
) {
  const personId = randomUUID();
  const applicationId = randomUUID();
  const vehicleModelId = randomUUID();
  const productId = randomUUID();
  const ruleId = randomUUID();
  const offerId = randomUUID();
  const offerVersionId = randomUUID();
  const vehicleUnitId = randomUUID();
  const contractId = randomUUID();
  const scheduleId = randomUUID();
  const installmentId = randomUUID();
  const paymentTransactionId = randomUUID();
  const ledgerEntryId = randomUUID();
  const suffix = randomUUID();

  await pool.query(
    `insert into privacy.person (id, phone_e164) values ($1, $2)`,
    [personId, `+23320${suffix.replaceAll("-", "").slice(0, 7)}`],
  );
  await pool.query(
    `insert into application (id, applicant_person_id) values ($1, $2)`,
    [applicationId, personId],
  );
  await pool.query(
    `insert into vehicle_model (id, manufacturer, model_name, model_year)
     values ($1, 'Maker', 'Pilot', 2026)`,
    [vehicleModelId],
  );
  await pool.query(
    `insert into product (id, code, name, vehicle_model_id)
     values ($1, $2, 'Pilot product', $3)`,
    [productId, `PRODUCT-${suffix}`, vehicleModelId],
  );
  await pool.query(
    `insert into financing_rule_version
       (id, product_id, version_number, minimum_deposit_minor_units,
        annual_rate_bps, allowed_tenures_months, repayment_frequencies,
        calculation_method)
     values ($1, $2, 1, 10000, 1200, '[12]'::jsonb,
             '["MONTHLY"]'::jsonb, 'DECLINING_BALANCE')`,
    [ruleId, productId],
  );
  await pool.query(`insert into offer (id, application_id) values ($1, $2)`, [
    offerId,
    applicationId,
  ]);
  await pool.query(
    `insert into offer_version
       (id, offer_id, financing_rule_version_id, version_number,
        principal_minor_units, deposit_minor_units, total_payable_minor_units,
        terms)
     values ($1, $2, $3, 1, 100000, 10000, 110000, '{}'::jsonb)`,
    [offerVersionId, offerId, ruleId],
  );
  await pool.query(
    `insert into vehicle_unit (id, vehicle_model_id, vin, chassis_number)
     values ($1, $2, $3, $4)`,
    [vehicleUnitId, vehicleModelId, `VIN-${suffix}`, `CHASSIS-${suffix}`],
  );
  await pool.query(
    `insert into contract
       (id, reference, application_id, offer_version_id, vehicle_unit_id,
        status, outstanding_balance_minor_units)
     values ($1, $2, $3, $4, $5, 'ACTIVE', 100000)`,
    [
      contractId,
      `CONTRACT-${suffix}`,
      applicationId,
      offerVersionId,
      vehicleUnitId,
    ],
  );
  await pool.query(
    `insert into repayment_schedule
       (id, contract_id, version_number, total_minor_units, first_due_date)
     values ($1, $2, 1, 100000, '2026-09-01')`,
    [scheduleId, contractId],
  );
  await pool.query(
    `insert into installment
       (id, repayment_schedule_id, installment_number, due_date,
        amount_minor_units, paid_minor_units)
     values ($1, $2, 1, '2026-09-01', 100000, 10000)`,
    [installmentId, scheduleId],
  );
  await pool.query(
    `insert into payment_transaction
       (id, provider, provider_transaction_id, contract_id, payer_reference,
        amount_minor_units, provider_payload, occurred_at)
     values ($1, $2, $3, $4, '+233201234567', 10000, $5::jsonb,
             '2026-08-14T12:00:00.000Z')`,
    [
      paymentTransactionId,
      options.provider,
      `TXN-${suffix}`,
      contractId,
      JSON.stringify(
        options.channel === undefined ? {} : { channel: options.channel },
      ),
    ],
  );
  await pool.query(
    `insert into ledger_entry
       (id, contract_id, payment_transaction_id, installment_id, entry_type,
        direction, amount_minor_units, balance_after_minor_units, occurred_at)
     values ($1, $2, $3, $4, 'REPAYMENT', 'CREDIT', 10000, 90000,
             '2026-08-14T12:00:00.000Z')`,
    [ledgerEntryId, contractId, paymentTransactionId, installmentId],
  );
  await pool.query(
    `insert into registration_record
       (vehicle_unit_id, registration_number, registered_owner, valid_from)
     values ($1, $2, $3, '2026-08-14')`,
    [vehicleUnitId, `REG-${suffix}`, options.registeredOwner],
  );

  return { contractId, installmentId, ledgerEntryId };
}

async function expectLegacySchemaUnchanged(pool: Pool): Promise<void> {
  const columns = await pool.query<{
    column_name: string;
    data_type: string;
  }>(`
    select column_name, data_type
    from information_schema.columns
    where table_schema = 'public'
      and ((table_name = 'installment' and column_name = 'contract_id')
        or (table_name = 'ledger_entry' and column_name = 'posting_key')
        or (table_name = 'payment_transaction' and column_name in ('provider', 'channel')))
    order by column_name
  `);
  expect(columns.rows).toEqual([
    { column_name: "provider", data_type: "text" },
  ]);
}
