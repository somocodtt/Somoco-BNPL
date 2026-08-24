import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { Pool, type PoolClient } from "pg";
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
import {
  arrearsEscalation,
  recoveryAction,
  recoveryDecision,
  settlementEvidence,
} from "./schema/collections.js";
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
    expect(before.rows[0]?.count).toBe(33);
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

  it("allows the runtime role to bind only an unbound receipt contract", async () => {
    const graph = await insertFinancialGraph(db);
    const receiptId = randomUUID();
    await db.execute(sql`
      insert into payment_receipt
        (id, payment_transaction_id, contract_id, receipt_number,
         payer_reference, amount_minor_units, currency, issued_at, secure_path)
      values
        (${receiptId}::uuid, ${graph.paymentTransactionId}::uuid, null,
         ${`SOMO-${receiptId.slice(0, 12).toUpperCase()}`}, '+233201234567',
         10000, 'GHS', now(), ${`/receipts/${receiptId}`})
    `);

    const privileges = await db.execute<{
      contract_update: boolean;
      receipt_number_update: boolean;
      table_update: boolean;
      receipt_delete: boolean;
    }>(sql`
      select
        has_column_privilege('somo_runtime', 'payment_receipt', 'contract_id', 'UPDATE') as contract_update,
        has_column_privilege('somo_runtime', 'payment_receipt', 'receipt_number', 'UPDATE') as receipt_number_update,
        has_table_privilege('somo_runtime', 'payment_receipt', 'UPDATE') as table_update,
        has_table_privilege('somo_runtime', 'payment_receipt', 'DELETE') as receipt_delete
    `);
    expect(privileges.rows[0]).toEqual({
      contract_update: true,
      receipt_number_update: false,
      table_update: false,
      receipt_delete: false,
    });

    await runAsRuntimeRole((client) =>
      client.query(
        `update payment_receipt
            set contract_id = $1::uuid
          where id = $2::uuid`,
        [graph.contractId, receiptId],
      ),
    );

    await expect(
      runAsRuntimeRole((client) =>
        client.query(
          `update payment_receipt
              set receipt_number = 'TAMPERED'
            where id = $1::uuid`,
          [receiptId],
        ),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runAsRuntimeRole((client) =>
        client.query(`delete from payment_receipt where id = $1::uuid`, [
          receiptId,
        ]),
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      runAsRuntimeRole((client) =>
        client.query(
          `update payment_receipt
              set contract_id = null
            where id = $1::uuid`,
          [receiptId],
        ),
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps settlement evidence append-only and limits runtime privileges", async () => {
    const graph = await insertFinancialGraph(db);
    const staffId = randomUUID();
    const evidenceId = randomUUID();
    await db.execute(sql`
      insert into staff_user (id, email, password_hash, status, version)
      values (${staffId}, ${`${staffId}@example.test`}, 'hash', 'ACTIVE', 1)
    `);
    await db.insert(settlementEvidence).values({
      id: evidenceId,
      contractId: graph.contractId,
      evidenceDocumentReference: "legacy/revoked.pdf",
      evidenceHash: "a".repeat(64),
      verificationStatus: "REVOKED",
      acceptedBy: staffId,
      acceptedAt: new Date(),
    });

    await expect(
      db
        .update(settlementEvidence)
        .set({ evidenceDocumentReference: "tampered.pdf" })
        .where(sql`${settlementEvidence.id} = ${evidenceId}`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(
      db
        .delete(settlementEvidence)
        .where(sql`${settlementEvidence.id} = ${evidenceId}`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });

    const privileges = await db.execute<{
      settlement_select: boolean;
      settlement_insert: boolean;
      settlement_update: boolean;
      settlement_delete: boolean;
    }>(sql`
      select
        has_table_privilege('somo_runtime', 'settlement_evidence', 'SELECT') as settlement_select,
        has_table_privilege('somo_runtime', 'settlement_evidence', 'INSERT') as settlement_insert,
        has_table_privilege('somo_runtime', 'settlement_evidence', 'UPDATE') as settlement_update,
        has_table_privilege('somo_runtime', 'settlement_evidence', 'DELETE') as settlement_delete
    `);
    expect(privileges.rows[0]).toEqual({
      settlement_select: true,
      settlement_insert: true,
      settlement_update: false,
      settlement_delete: false,
    });
  });

  it("makes the approved payment allocation policy read-only to the runtime role", async () => {
    const privileges = await db.execute<{
      policy_select: boolean;
      policy_insert: boolean;
      policy_update: boolean;
      policy_delete: boolean;
    }>(sql`
      select
        has_table_privilege('somo_runtime', 'payment_allocation_policy', 'SELECT') as policy_select,
        has_table_privilege('somo_runtime', 'payment_allocation_policy', 'INSERT') as policy_insert,
        has_table_privilege('somo_runtime', 'payment_allocation_policy', 'UPDATE') as policy_update,
        has_table_privilege('somo_runtime', 'payment_allocation_policy', 'DELETE') as policy_delete
    `);
    expect(privileges.rows[0]).toEqual({
      policy_select: true,
      policy_insert: false,
      policy_update: false,
      policy_delete: false,
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
    await db.insert(registrationRecord).values({
      vehicleUnitId: graph.vehicleUnitId,
      registrationNumber: "REG-SOMOCO-1001",
      registeredOwner: "SOMOCO",
      validFrom: "2026-08-14",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    const registrationEvidenceDocumentId = randomUUID();
    await db.execute(sql`
      insert into privacy.document
        (id, person_id, document_type, object_key, declared_mime_type,
         declared_size_bytes, upload_ticket_hash, upload_expires_at,
         accepted_object_key, accepted_object_version_id,
         accepted_object_etag, sha256, status, malware_scanned)
      select ${registrationEvidenceDocumentId}::uuid,
             application.applicant_person_id,
             'TRANSFER_EVIDENCE',
             ${`pending/${registrationEvidenceDocumentId}`},
             'application/pdf', 128, repeat('a', 64), now() + interval '5 minutes',
             ${`accepted/${registrationEvidenceDocumentId}`},
             'v1', 'etag', repeat('b', 64), 'ACCEPTED', true
        from contract
        join application on application.id = contract.application_id
       where contract.id = ${graph.contractId}
    `);

    const completed = await completeOwnershipTransfer(database, {
      id: transferId,
      expectedVersion: 1,
      evidence: { registrationEvidenceDocumentId },
      transferredAt: new Date("2026-08-14T12:00:00.000Z"),
      effects: writeEffects(transferId, "OWNERSHIP_TRANSFER_COMPLETED"),
    });

    expect(completed.status).toBe("COMPLETED");
    expect(completed.version).toBe(2);
    expect(await countRows(db, "audit_event")).toBe(1);
    expect(await countRows(db, "outbox_message")).toBe(1);

    expect(await countRows(db, "registration_record")).toBe(2);
    const authoritative = await db.execute<{
      contract_status: string;
      ownership_holder: string;
      vehicle_status: string;
      registered_owner: string;
      evidence_document_id: string;
    }>(sql`
      select c.status::text as contract_status, c.ownership_holder,
             v.status::text as vehicle_status,
             r.registered_owner::text, r.evidence_document_id::text
        from contract c join vehicle_unit v on v.id = c.vehicle_unit_id
        join lateral (
          select * from registration_record where vehicle_unit_id = v.id
           order by created_at desc, id desc limit 1
        ) r on true
       where c.id = ${graph.contractId}
    `);
    expect(authoritative.rows[0]).toEqual({
      contract_status: "TRANSFERRED",
      ownership_holder: "CUSTOMER",
      vehicle_status: "TRANSFERRED",
      registered_owner: "CUSTOMER",
      evidence_document_id: registrationEvidenceDocumentId,
    });
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

  it("requires every reversal or refund ledger entry to link to an existing entry", async () => {
    const graph = await insertFinancialGraph(db);
    await expect(
      db.execute(sql`
        insert into ledger_entry
          (posting_key, contract_id, entry_type, direction, currency, amount_minor_units, balance_after_minor_units, occurred_at)
        values
          (${`missing-link-${randomUUID()}`}, ${graph.contractId}, 'REVERSAL', 'DEBIT', 'GHS', 1, 1, now())
      `),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.execute(sql`
        insert into ledger_entry
          (posting_key, contract_id, entry_type, direction, currency, amount_minor_units, balance_after_minor_units, reverses_entry_id, occurred_at)
        values
          (${`foreign-link-${randomUUID()}`}, ${graph.contractId}, 'REFUND', 'DEBIT', 'GHS', 1, 1, ${randomUUID()}, now())
      `),
    ).rejects.toMatchObject({ cause: { code: "23503" } });
  });

  it("keeps arrears and recovery evidence append-only and settlement evidence clean-bound", async () => {
    const graph = await insertFinancialGraph(db);
    const staffId = randomUUID();
    const checkerId = randomUUID();
    await db.execute(sql`
      insert into staff_user (id, email, password_hash, status, version)
      values (${staffId}, ${`${staffId}@example.test`}, 'hash', 'ACTIVE', 1)
    `);
    await db.execute(sql`
      insert into staff_user (id, email, password_hash, status, version)
      values (${checkerId}, ${`${checkerId}@example.test`}, 'hash', 'ACTIVE', 1)
    `);
    const recoveryCaseId = randomUUID();
    await db.execute(sql`
      insert into recovery_case (id, contract_id, status, details, version, opened_at)
      values (${recoveryCaseId}, ${graph.contractId}, 'OPEN', '{}'::jsonb, 1, now())
    `);
    const escalation = await db
      .insert(arrearsEscalation)
      .values({
        contractId: graph.contractId,
        asOfDate: "2026-08-21",
        signal: "THREE_TOTAL_UNPAID",
        overdueMinorUnits: 100n,
        unpaidInstallments: 3,
        consecutiveMissedInstallments: 1,
      })
      .returning();
    await expect(
      db
        .update(arrearsEscalation)
        .set({ unpaidInstallments: 4 })
        .where(sql`${arrearsEscalation.id} = ${escalation[0]!.id}`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    const decision = await db
      .insert(recoveryDecision)
      .values({
        recoveryCaseId,
        idempotencyKey: randomUUID(),
        makerStaffUserId: staffId,
        checkerStaffUserId: checkerId,
        decision: "DENIED",
        purpose: "TEST_REVIEW",
        reason: "No authorized action",
        decidedAt: new Date(),
      })
      .returning();
    await expect(
      db
        .delete(recoveryDecision)
        .where(sql`${recoveryDecision.id} = ${decision[0]!.id}`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
    await expect(
      db.insert(settlementEvidence).values({
        contractId: graph.contractId,
        evidenceDocumentReference: "document-test-1",
        evidenceHash: "a".repeat(64),
        verificationStatus: "CLEAN",
        acceptedBy: staffId,
        acceptedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    await expect(
      db.insert(recoveryAction).values({
        recoveryCaseId,
        actionType: "MANUAL_RECOVERY",
        purpose: "TEST_ACTION",
        requestedBy: staffId,
        authorizedBy: staffId,
        evidenceHash: "b".repeat(64),
        evidence: {},
      }),
    ).rejects.toMatchObject({ cause: { code: "23514" } });
    const validAction = await db
      .insert(recoveryAction)
      .values({
        recoveryCaseId,
        actionType: "MANUAL_RECOVERY",
        purpose: "TEST_ACTION",
        requestedBy: staffId,
        authorizedBy: checkerId,
        evidenceHash: "c".repeat(64),
        evidence: {},
        idempotencyKey: `db-action-${randomUUID()}`,
        payloadHash: "d".repeat(64),
      })
      .returning();
    await expect(
      db
        .update(recoveryAction)
        .set({ payloadHash: "e".repeat(64) })
        .where(sql`${recoveryAction.id} = ${validAction[0]!.id}`),
    ).rejects.toMatchObject({ cause: { code: "55000" } });
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

  it("upgrades populated payment and ledger rows through the payment migration without changing financial values", async () => {
    const legacy = await insertLegacyFinancialGraph(pool, {
      provider: "SOMOCO_PAYMENTS",
      channel: "USSD",
      registeredOwner: "SOMOCO",
    });
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
      "0008_regular_juggernaut.sql",
      "0009_whole_nightmare.sql",
      "0010_controlled_financing.sql",
      "0011_financing_binding.sql",
      "0012_financing_disclosures.sql",
      "0013_asset_contract_handover.sql",
      "0014_asset_hardening.sql",
      "0015_asset_privacy_controls.sql",
      "0016_payment_ledger_reconciliation.sql",
      "0017_wooden_selene.sql",
      "0018_sealed_payment_policy.sql",
      "0019_external_payment_policy_evidence.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }
    const financial = await pool.query<{
      payment_amount: string;
      ledger_amount: string;
      payment_event_id: string | null;
      receipt_count: number;
      settlement_count: number;
    }>(
      `select payment.amount_minor_units::text as payment_amount,
              ledger.amount_minor_units::text as ledger_amount,
              payment.event_id as payment_event_id,
              (select count(*)::int from payment_receipt) as receipt_count,
              (select count(*)::int from payment_settlement_batch) as settlement_count
         from payment_transaction payment
         join ledger_entry ledger on ledger.payment_transaction_id = payment.id
        where payment.id = $1`,
      [legacy.paymentTransactionId],
    );
    expect(financial.rows[0]).toEqual({
      payment_amount: "10000",
      ledger_amount: "10000",
      payment_event_id: null,
      receipt_count: 0,
      settlement_count: 0,
    });
    await expect(
      pool.query(
        `select distinct trigger_name from information_schema.triggers
          where event_object_table in ('payment_receipt', 'payment_settlement_batch')
          order by trigger_name`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { trigger_name: "payment_receipt_append_only" },
        { trigger_name: "payment_settlement_batch_append_only" },
      ],
    });
  });

  it("revokes legacy approved allocation policy rows without inventing external evidence", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
      "0008_regular_juggernaut.sql",
      "0009_whole_nightmare.sql",
      "0010_controlled_financing.sql",
      "0011_financing_binding.sql",
      "0012_financing_disclosures.sql",
      "0013_asset_contract_handover.sql",
      "0014_asset_hardening.sql",
      "0015_asset_privacy_controls.sql",
      "0016_payment_ledger_reconciliation.sql",
      "0017_wooden_selene.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }
    await pool.query(
      `insert into payment_allocation_policy
        (version, policy_hash, worked_example_hash, worked_example,
         finance_approved_by, compliance_approved_by, approved_at, status)
       values ($1, $2, $2, $3::jsonb, 'legacy-finance', 'legacy-compliance', now(), 'APPROVED')`,
      [
        "legacy-finance-policy-v1",
        "a".repeat(64),
        JSON.stringify({ externalArtifactId: "legacy-policy" }),
      ],
    );
    await applyMigrationFile(pool, "0018_sealed_payment_policy.sql");
    await applyMigrationFile(pool, "0019_external_payment_policy_evidence.sql");
    const result = await pool.query<{ status: string }>(
      `select status from payment_allocation_policy where version = $1`,
      ["legacy-finance-policy-v1"],
    );
    expect(result.rows[0]?.status).toBe("REVOKED");
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

  it("adds approval controls to a populated 0008 schema without changing existing rows", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
      "0008_regular_juggernaut.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }

    const applicantId = randomUUID();
    const guarantorId = randomUUID();
    const applicationId = randomUUID();
    const relationshipId = randomUUID();
    const applicationVersionId = randomUUID();
    const delegatedStaffUserId = randomUUID();
    const approvingStaffUserId = randomUUID();
    await pool.query(
      `insert into privacy.person (id, phone_e164)
       values ($1, '+233200009908'), ($2, '+233200009909')`,
      [applicantId, guarantorId],
    );
    await pool.query(
      `insert into application
         (id, applicant_person_id, status, version, submitted_at)
       values ($1, $2, 'VERIFICATION_REVIEW', 1, '2026-08-20T12:00:00.000Z')`,
      [applicationId, applicantId],
    );
    await pool.query(
      `insert into application_version
         (id, application_id, version_number, snapshot, submitted_at)
       values ($1, $2, 1, '{"legacy":true,"source":"0008"}'::jsonb,
               '2026-08-20T12:00:00.000Z')`,
      [applicationVersionId, applicationId],
    );
    await pool.query(
      `insert into guarantor_relationship
         (id, application_id, guarantor_person_id, status)
       values ($1, $2, $3, 'CONFIRMED')`,
      [relationshipId, applicationId, guarantorId],
    );
    await pool.query(
      `insert into staff_user (id, email, password_hash)
       values ($1, 'delegated-legacy@example.test', 'legacy-hash'),
              ($2, 'approver-legacy@example.test', 'legacy-hash')`,
      [delegatedStaffUserId, approvingStaffUserId],
    );

    await applyMigrationFile(pool, "0009_whole_nightmare.sql");

    const preserved = await pool.query<{
      application_id: string;
      status: string;
      version: number;
      information_requested_stage: string | null;
      snapshot: Record<string, unknown>;
      relationship_id: string;
    }>(
      `select a.id application_id, a.status, a.version,
              a.information_requested_stage, av.snapshot,
              gr.id relationship_id
         from application a
         join application_version av on av.application_id = a.id
         join guarantor_relationship gr on gr.application_id = a.id
        where a.id = $1`,
      [applicationId],
    );
    expect(preserved.rows[0]).toEqual({
      application_id: applicationId,
      status: "VERIFICATION_REVIEW",
      version: 1,
      information_requested_stage: null,
      snapshot: { legacy: true, source: "0008" },
      relationship_id: relationshipId,
    });

    const commandId = randomUUID();
    const delegationId = randomUUID();
    await pool.query(
      `insert into staff_delegation
         (id, delegated_staff_user_id, delegated_role, scope, approved_by,
          approved_at, effective_from, effective_until, status)
       values ($1, $2, 'VERIFICATION_OFFICER', '["VERIFICATION"]'::jsonb,
               $3, '2026-08-20T11:00:00.000Z', '2026-08-20T11:00:00.000Z',
               '2026-08-20T13:00:00.000Z', 'APPROVED')`,
      [delegationId, delegatedStaffUserId, approvingStaffUserId],
    );
    await pool.query(
      `insert into workflow_command
         (id, application_id, idempotency_key, command_type, payload_hash,
          request_id, actor_staff_user_id, response)
       values ($1, $2, $3, 'APPROVAL', repeat('a', 64), $4, $5, '{}'::jsonb)`,
      [
        commandId,
        applicationId,
        randomUUID(),
        randomUUID(),
        delegatedStaffUserId,
      ],
    );
    await expect(
      pool.query(
        `select id from staff_delegation where id = $1 and status = 'APPROVED'`,
        [delegationId],
      ),
    ).resolves.toMatchObject({ rows: [{ id: delegationId }] });
    await expect(
      pool.query(
        `select id from workflow_command where id = $1 and application_id = $2`,
        [commandId, applicationId],
      ),
    ).resolves.toMatchObject({ rows: [{ id: commandId }] });
  });

  it("upgrades populated 0009 financing rows safely through 0024", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
      "0008_regular_juggernaut.sql",
      "0009_whole_nightmare.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }

    const applicantId = randomUUID();
    const vehicleModelId = randomUUID();
    const productId = randomUUID();
    const ruleId = randomUUID();
    const applicationId = randomUUID();
    const offerId = randomUUID();
    const offerVersionId = randomUUID();
    await pool.query(
      `insert into privacy.person (id, phone_e164) values ($1, '+233200009910')`,
      [applicantId],
    );
    await pool.query(
      `insert into vehicle_model (id, manufacturer, model_name, model_year)
       values ($1, 'Legacy Motors', 'Legacy Pilot', 2025)`,
      [vehicleModelId],
    );
    await pool.query(
      `insert into product (id, code, name, vehicle_model_id)
       values ($1, 'LEGACY-0010', 'Legacy financing product', $2)`,
      [productId, vehicleModelId],
    );
    await pool.query(
      `insert into financing_rule_version
         (id, product_id, version_number, minimum_deposit_minor_units,
          annual_rate_bps, allowed_tenures_months, repayment_frequencies,
          calculation_method)
       values ($1, $2, 1, 10000, 1200, '[12]'::jsonb, '["MONTHLY"]'::jsonb,
               'DECLINING_BALANCE')`,
      [ruleId, productId],
    );
    await pool.query(
      `insert into application
         (id, applicant_person_id, product_id, status, version, submitted_at)
       values ($1, $2, $3, 'APPROVED', 7, '2026-08-20T12:00:00.000Z')`,
      [applicationId, applicantId, productId],
    );
    await pool.query(
      `insert into offer (id, application_id, accepted_at)
       values ($1, $2, '2026-08-20T12:05:00.000Z')`,
      [offerId, applicationId],
    );
    await pool.query(
      `insert into offer_version
         (id, offer_id, financing_rule_version_id, version_number,
          principal_minor_units, deposit_minor_units, total_payable_minor_units,
          terms)
       values ($1, $2, $3, 1, 100000, 10000, 110000, '{}'::jsonb)`,
      [offerVersionId, offerId, ruleId],
    );
    await pool.query(
      `update offer set accepted_version_id = $2 where id = $1`,
      [offerId, offerVersionId],
    );

    await applyMigrationFile(pool, "0010_controlled_financing.sql");
    await applyMigrationFile(pool, "0011_financing_binding.sql");
    await applyMigrationFile(pool, "0012_financing_disclosures.sql");
    await applyMigrationFile(pool, "0013_asset_contract_handover.sql");
    await applyMigrationFile(pool, "0014_asset_hardening.sql");
    await applyMigrationFile(pool, "0015_asset_privacy_controls.sql");
    await applyMigrationFile(pool, "0016_payment_ledger_reconciliation.sql");
    await applyMigrationFile(pool, "0017_wooden_selene.sql");
    await applyMigrationFile(pool, "0018_sealed_payment_policy.sql");
    await applyMigrationFile(pool, "0019_external_payment_policy_evidence.sql");
    await applyMigrationFile(pool, "0020_flippant_bishop.sql");
    await applyMigrationFile(pool, "0021_high_siren.sql");
    await applyMigrationFile(pool, "0022_condemned_deathbird.sql");
    await applyMigrationFile(pool, "0023_bound_settlement_evidence.sql");
    await applyMigrationFile(pool, "0024_safe_evidence_replacement.sql");

    const migrated = await pool.query<{
      calculation_method: string;
      minimum_deposit_minor_units: string;
      status: string;
      principal_minor_units: string;
      canonical_hash: string | null;
      disclosed_version: string | null;
      disclosure_hash: string | null;
      disclosure_content: Record<string, unknown> | null;
    }>(
      `select rule.calculation_method, rule.minimum_deposit_minor_units,
              offer.status, version.principal_minor_units, version.canonical_hash,
              offer.disclosed_version, rule.disclosure_hash,
              rule.disclosure_content
         from financing_rule_version rule
         join offer_version version on version.financing_rule_version_id = rule.id
         join offer on offer.id = version.offer_id
        where rule.id = $1`,
      [ruleId],
    );
    expect(migrated.rows[0]).toEqual({
      calculation_method: "REDUCING_BALANCE",
      minimum_deposit_minor_units: "10000",
      status: "ACCEPTED",
      principal_minor_units: "100000",
      canonical_hash: null,
      disclosed_version: null,
      disclosure_hash: null,
      disclosure_content: null,
    });
    await expect(
      pool.query(
        `select column_name from information_schema.columns
          where table_name = 'recovery_action'
            and column_name in ('idempotency_key', 'payload_hash')
         order by column_name`,
      ),
    ).resolves.toMatchObject({
      rows: [
        { column_name: "idempotency_key" },
        { column_name: "payload_hash" },
      ],
    });
    const preserved = await pool.query<{
      application_id: string;
      status: string;
      principal_minor_units: string;
    }>(
      `select application.id as application_id, application.status,
              offer_version.principal_minor_units
         from application
         join offer on offer.application_id = application.id
         join offer_version on offer_version.offer_id = offer.id
        where application.id = $1`,
      [applicationId],
    );
    expect(preserved.rows[0]).toEqual({
      application_id: applicationId,
      status: "APPROVED",
      principal_minor_units: "100000",
    });
  });

  it("preserves populated migration evidence and enforces append-only lifecycles in 0027", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
      "0008_regular_juggernaut.sql",
      "0009_whole_nightmare.sql",
      "0010_controlled_financing.sql",
      "0011_financing_binding.sql",
      "0012_financing_disclosures.sql",
      "0013_asset_contract_handover.sql",
      "0014_asset_hardening.sql",
      "0015_asset_privacy_controls.sql",
      "0016_payment_ledger_reconciliation.sql",
      "0017_wooden_selene.sql",
      "0018_sealed_payment_policy.sql",
      "0019_external_payment_policy_evidence.sql",
      "0020_flippant_bishop.sql",
      "0021_high_siren.sql",
      "0022_condemned_deathbird.sql",
      "0023_bound_settlement_evidence.sql",
      "0024_safe_evidence_replacement.sql",
    ]) {
      await applyMigrationFile(pool, migration);
    }

    const batchId = randomUUID();
    const recordId = randomUUID();
    const sourceRecordId = `legacy-${randomUUID()}`;
    const payload = { sourceRecordId, currentBalanceMinorUnits: "12345" };
    await pool.query(
      `insert into migration_batch (id, source, source_batch_id, expected_records)
       values ($1, 'LEGACY_CSV', $2, 1)`,
      [batchId, `batch-${randomUUID()}`],
    );
    await pool.query(
      `insert into migration_record (id, migration_batch_id, source_record_id, payload)
       values ($1, $2, $3, $4::jsonb)`,
      [recordId, batchId, sourceRecordId, JSON.stringify(payload)],
    );

    await applyMigrationFile(pool, "0025_bumpy_kang.sql");
    await applyMigrationFile(pool, "0026_loose_stellaris.sql");
    await applyMigrationFile(
      pool,
      "0027_complete_export_and_migration_lifecycles.sql",
    );
    const otherBatchId = randomUUID();
    const otherRecordId = randomUUID();
    const nullRecordId = randomUUID();
    const verifierId = randomUUID();
    await pool.query(
      `insert into staff_user (id, email, password_hash, status)
       values ($1, $2, 'hash', 'ACTIVE')`,
      [verifierId, `${verifierId}@example.test`],
    );
    await pool.query(
      `insert into migration_batch (id, source, source_batch_id, expected_records)
       values ($1, 'LEGACY_CSV', $2, 1)`,
      [otherBatchId, `other-${randomUUID()}`],
    );
    await pool.query(
      `insert into migration_record (id, migration_batch_id, source_record_id, payload)
       values ($1, $2, $3, '{}'::jsonb)`,
      [otherRecordId, otherBatchId, `other-row-${randomUUID()}`],
    );
    await pool.query(
      `insert into migration_record (id, migration_batch_id, source_record_id, payload)
       values ($1, $2, $3, '{}'::jsonb)`,
      [nullRecordId, batchId, `null-command-row-${randomUUID()}`],
    );
    await pool.query(
      `alter table migration_sample_evidence
         add column verification_command_id uuid`,
    );
    const validCommandId = randomUUID();
    const crossBatchEvidenceId = randomUUID();
    const nullCommandEvidenceId = randomUUID();
    await pool.query(
      `insert into migration_sample_evidence
        (id, migration_batch_id, migration_record_id, verifier_staff_user_id,
         result, verification_command_id)
       values ($1, $2, $3, $4, 'PASS', $5),
              ($6, $2, $7, $4, 'PASS', $8),
              ($9, $2, $10, $4, 'PASS', null)`,
      [
        validCommandId,
        batchId,
        recordId,
        verifierId,
        validCommandId,
        crossBatchEvidenceId,
        otherRecordId,
        randomUUID(),
        nullCommandEvidenceId,
        nullRecordId,
      ],
    );
    await applyMigrationFile(
      pool,
      "0028_composite_migration_sample_binding.sql",
    );
    await applyMigrationFile(
      pool,
      "0030_require_sample_verification_command.sql",
    );

    const preserved = await pool.query<{
      source_record_id: string;
      payload: Record<string, unknown>;
      template_version: string;
    }>(
      `select source_record_id, payload, template_version
         from migration_record
        where id = $1`,
      [recordId],
    );
    expect(preserved.rows[0]).toEqual({
      source_record_id: sourceRecordId,
      payload,
      template_version: "legacy-v1",
    });

    const baseline = await pool.query<{
      event_type: string;
      status: string;
    }>(
      `select event_type, status
         from migration_batch_transition
        where migration_batch_id = $1`,
      [batchId],
    );
    expect(baseline.rows).toEqual([
      { event_type: "CORRECTED", status: "QUARANTINED" },
    ]);

    const activeEvidence = await pool.query<{
      id: string;
      migration_record_id: string;
      verification_command_id: string | null;
    }>(
      `select id, migration_record_id, verification_command_id
         from migration_sample_evidence
        where migration_batch_id = $1
        order by id`,
      [batchId],
    );
    expect(activeEvidence.rows).toEqual([
      {
        id: validCommandId,
        migration_record_id: recordId,
        verification_command_id: validCommandId,
      },
    ]);
    await expect(
      pool.query(
        `insert into migration_sample_evidence
          (migration_batch_id, migration_record_id, verifier_staff_user_id,
           result, verification_command_id)
         values ($1, $2, $3, 'PASS', null)`,
        [batchId, recordId, verifierId],
      ),
    ).rejects.toMatchObject({ code: "23502" });
    const quarantinedEvidence = await pool.query<{
      original_evidence_id: string;
      migration_record_id: string;
      result: string;
      verification_command_id: string | null;
      reason_code: string;
    }>(
      `select original_evidence_id, migration_record_id, result,
              verification_command_id, reason_code
         from migration_sample_evidence_quarantine
        where migration_batch_id = $1
        order by original_evidence_id`,
      [batchId],
    );
    expect(quarantinedEvidence.rows).toEqual(
      expect.arrayContaining([
        {
          original_evidence_id: crossBatchEvidenceId,
          migration_record_id: otherRecordId,
          result: "PASS",
          verification_command_id: expect.any(String),
          reason_code: "CROSS_BATCH_RECORD",
        },
        {
          original_evidence_id: nullCommandEvidenceId,
          migration_record_id: nullRecordId,
          result: "PASS",
          verification_command_id: null,
          reason_code: "MISSING_VERIFICATION_COMMAND",
        },
      ]),
    );
    await expect(
      pool.query(
        `update migration_sample_evidence_quarantine
            set reason_code = 'TAMPERED'
          where original_evidence_id = $1`,
        [nullCommandEvidenceId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        `delete from migration_sample_evidence_quarantine
          where original_evidence_id = $1`,
        [nullCommandEvidenceId],
      ),
    ).rejects.toMatchObject({ code: "55000" });

    await expect(
      pool.query(
        `update migration_batch set status = 'VALIDATED' where id = $1`,
        [batchId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`delete from migration_batch where id = $1`, [batchId]),
    ).rejects.toMatchObject({ code: "55000" });
    const transitionId = await pool.query<{ id: string }>(
      `select id from migration_batch_transition where migration_batch_id = $1`,
      [batchId],
    );
    await expect(
      pool.query(
        `update migration_batch_transition set status = 'VALIDATED' where id = $1`,
        [transitionId.rows[0]!.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`delete from migration_batch_transition where id = $1`, [
        transitionId.rows[0]!.id,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        `insert into migration_sample_evidence
          (migration_batch_id, migration_record_id, verifier_staff_user_id,
           result, verification_command_id)
         values ($1, $2, $3, 'PASS', $4)`,
        [batchId, otherRecordId, verifierId, randomUUID()],
      ),
    ).rejects.toMatchObject({ code: "23503" });

    await expect(
      pool.query(`update migration_record set status = 'VALID' where id = $1`, [
        recordId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`update migration_record set target_id = $2 where id = $1`, [
        recordId,
        randomUUID(),
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(
        `update migration_record set payload = '{"tampered":true}'::jsonb where id = $1`,
        [recordId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`delete from migration_record where id = $1`, [recordId]),
    ).rejects.toMatchObject({ code: "55000" });

    const privileges = await pool.query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.role_table_grants
        where grantee = 'somo_runtime'
          and table_name = 'migration_record'
        order by privilege_type`,
    );
    expect(privileges.rows.map((row) => row.privilege_type)).toEqual([
      "INSERT",
      "SELECT",
    ]);
  });

  it("quarantines populated unbound CLEAN evidence before enforcing new bindings", async () => {
    for (const migration of [
      "0001_fresh_talon.sql",
      "0002_lovely_maginty.sql",
      "0003_square_zaran.sql",
      "0004_tearful_dark_phoenix.sql",
      "0005_fantastic_kabuki.sql",
      "0006_worthless_marrow.sql",
      "0007_concerned_siren.sql",
      "0008_regular_juggernaut.sql",
      "0009_whole_nightmare.sql",
      "0010_controlled_financing.sql",
      "0011_financing_binding.sql",
      "0012_financing_disclosures.sql",
      "0013_asset_contract_handover.sql",
      "0014_asset_hardening.sql",
      "0015_asset_privacy_controls.sql",
      "0016_payment_ledger_reconciliation.sql",
      "0017_wooden_selene.sql",
      "0018_sealed_payment_policy.sql",
      "0019_external_payment_policy_evidence.sql",
      "0020_flippant_bishop.sql",
      "0021_high_siren.sql",
      "0022_condemned_deathbird.sql",
    ])
      await applyMigrationFile(pool, migration);

    const legacy = await insertLegacyFinancialGraph(pool, {
      provider: "SOMOCO_PAYMENTS",
      channel: "USSD",
      registeredOwner: "SOMOCO",
      calculationMethod: "REDUCING_BALANCE",
    });
    const staffId = randomUUID();
    await pool.query(
      `insert into staff_user (id, email, password_hash) values ($1, $2, 'hash')`,
      [staffId, `${staffId}@example.test`],
    );
    const revokedId = randomUUID();
    await pool.query(
      `insert into settlement_evidence
        (id, contract_id, evidence_document_reference, evidence_hash,
         verification_status, accepted_by, accepted_at)
       values ($1, $2, 'legacy/unbound.pdf', repeat('a', 64), 'CLEAN', $3, now())`,
      [revokedId, legacy.contractId, staffId],
    );

    await applyMigrationFile(pool, "0023_bound_settlement_evidence.sql");
    await applyMigrationFile(pool, "0024_safe_evidence_replacement.sql");
    await expect(
      pool.query(
        `select verification_status from settlement_evidence where contract_id = $1`,
        [legacy.contractId],
      ),
    ).resolves.toMatchObject({ rows: [{ verification_status: "REVOKED" }] });
    const applicant = await pool.query<{ applicant_person_id: string }>(
      `select a.applicant_person_id
         from contract c join application a on a.id = c.application_id
        where c.id = $1`,
      [legacy.contractId],
    );
    const documentId = randomUUID();
    await pool.query(
      `insert into privacy.document
        (id, person_id, document_type, object_key, declared_mime_type,
         declared_size_bytes, upload_ticket_hash, upload_expires_at,
         accepted_object_key, accepted_object_version_id, accepted_object_etag,
         sha256, status, malware_scanned)
       values ($1, $2, 'TRANSFER_EVIDENCE', $3, 'application/pdf', 128,
               repeat('c', 64), now() + interval '5 minutes', $4, 'v1', 'etag',
               repeat('d', 64), 'ACCEPTED', true)`,
      [
        documentId,
        applicant.rows[0]!.applicant_person_id,
        `pending/${documentId}`,
        `accepted/${documentId}`,
      ],
    );
    await pool.query(
      `insert into settlement_evidence
        (id, contract_id, evidence_document_id, evidence_document_reference,
         evidence_hash, evidence_object_key, evidence_object_version_id,
         evidence_object_etag, verification_status, accepted_by, accepted_at)
       values ($1, $2, $3, $4, repeat('d', 64), $4, 'v1', 'etag', 'CLEAN', $5, now())`,
      [
        randomUUID(),
        legacy.contractId,
        documentId,
        `accepted/${documentId}`,
        staffId,
      ],
    );
    await expect(
      pool.query(
        `insert into settlement_evidence
          (contract_id, evidence_document_id, evidence_document_reference,
           evidence_hash, evidence_object_key, evidence_object_version_id,
           evidence_object_etag, verification_status, accepted_by, accepted_at)
         values ($1, $2, $3, repeat('d', 64), $3, 'v1', 'etag', 'CLEAN', $4, now())`,
        [legacy.contractId, documentId, `accepted/${documentId}`, staffId],
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(
        `select verification_status from settlement_evidence
          where id = $1`,
        [revokedId],
      ),
    ).resolves.toMatchObject({ rows: [{ verification_status: "REVOKED" }] });
    await expect(
      pool.query(
        `select verification_status from settlement_evidence
          where contract_id = $1 order by verification_status`,
        [legacy.contractId],
      ),
    ).resolves.toMatchObject({
      rows: [
        { verification_status: "CLEAN" },
        { verification_status: "REVOKED" },
      ],
    });
    await expect(
      pool.query(
        `insert into settlement_evidence
          (contract_id, evidence_document_reference, evidence_hash,
           verification_status, accepted_by, accepted_at)
         values ($1, 'bypass.pdf', repeat('b', 64), 'CLEAN', $2, now())`,
        [legacy.contractId, staffId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("upgrades populated 0032 settlement and reconciliation rows through 0033", async () => {
    const journal = JSON.parse(
      await readFile(`${migrationsFolder}meta/_journal.json`, "utf8"),
    ) as { entries: ReadonlyArray<{ tag: string }> };
    for (const entry of journal.entries.slice(1, -1))
      await applyMigrationFile(pool, `${entry.tag}.sql`);

    const legacy = await insertLegacyFinancialGraph(pool, {
      provider: "SOMOCO_PAYMENTS",
      channel: "MOBILE_MONEY",
      registeredOwner: "SOMOCO",
      calculationMethod: "REDUCING_BALANCE",
    });
    const approverId = randomUUID();
    await pool.query(
      `insert into staff_user (id, email, password_hash)
       values ($1, $2, 'hash')`,
      [approverId, `${approverId}@example.test`],
    );
    const approvalId = randomUUID();
    await pool.query(
      `insert into settlement_approval
        (id, contract_id, approval_type, idempotency_key, approved_by,
         reason, approved_at)
       values ($1, $2, 'FINANCE_RECONCILIATION', $3, $4, 'legacy approval', now())`,
      [approvalId, legacy.contractId, `legacy-${approvalId}`, approverId],
    );
    const reconciliationId = randomUUID();
    await pool.query(
      `insert into reconciliation_case
        (id, payment_transaction_id, reason, status)
       values ($1, $2, 'LEGACY_REVIEW', 'OPEN')`,
      [reconciliationId, legacy.paymentTransactionId],
    );

    await applyMigrationFile(pool, "0033_final_controlled_pilot_hardening.sql");

    await expect(
      pool.query(
        `select approval.contract_version,
                approval.balance_minor_units::text,
                approval.ledger_digest,
                approval.reconciliation_checkpoint,
                approval.bundle_digest,
                contract.outstanding_balance_minor_units::text as contract_balance
           from settlement_approval approval
           join contract on contract.id = approval.contract_id
          where approval.id = $1`,
        [approvalId],
      ),
    ).resolves.toMatchObject({
      rows: [
        {
          contract_version: 1,
          balance_minor_units: "100000",
          contract_balance: "100000",
          ledger_digest: "0".repeat(64),
          reconciliation_checkpoint: "0".repeat(64),
          bundle_digest: "0".repeat(64),
        },
      ],
    });
    await expect(
      pool.query(`select contract_id from reconciliation_case where id = $1`, [
        reconciliationId,
      ]),
    ).resolves.toMatchObject({
      rows: [{ contract_id: legacy.contractId }],
    });
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
    calculationMethod: "REDUCING_BALANCE",
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

async function runAsRuntimeRole<T>(
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("set local role somo_runtime");
    const result = await operation(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
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
  calculationMethod?: "DECLINING_BALANCE" | "REDUCING_BALANCE";
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
             '["MONTHLY"]'::jsonb, $3)`,
    [ruleId, productId, options.calculationMethod ?? "DECLINING_BALANCE"],
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
  if (options.calculationMethod === "REDUCING_BALANCE") {
    await pool.query(
      `insert into installment
         (id, repayment_schedule_id, contract_id, installment_number, due_date,
          amount_minor_units, paid_minor_units)
       values ($1, $2, $3, 1, '2026-09-01', 100000, 10000)`,
      [installmentId, scheduleId, contractId],
    );
  } else {
    await pool.query(
      `insert into installment
         (id, repayment_schedule_id, installment_number, due_date,
          amount_minor_units, paid_minor_units)
       values ($1, $2, 1, '2026-09-01', 100000, 10000)`,
      [installmentId, scheduleId],
    );
  }
  if (options.calculationMethod === "REDUCING_BALANCE") {
    await pool.query(
      `insert into payment_transaction
         (id, provider, channel, provider_transaction_id, contract_id,
          payer_reference, amount_minor_units, provider_payload, occurred_at)
       values ($1, $2, $3, $4, $5, '+233201234567', 10000, $6::jsonb,
               '2026-08-14T12:00:00.000Z')`,
      [
        paymentTransactionId,
        options.provider,
        options.channel,
        `TXN-${suffix}`,
        contractId,
        JSON.stringify({ channel: options.channel }),
      ],
    );
  } else {
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
  }
  if (options.calculationMethod === "REDUCING_BALANCE") {
    await pool.query(
      `insert into ledger_entry
         (id, posting_key, contract_id, payment_transaction_id, installment_id,
          entry_type, direction, amount_minor_units, balance_after_minor_units,
          occurred_at)
       values ($1, $2, $3, $4, $5, 'REPAYMENT', 'CREDIT', 10000, 90000,
               '2026-08-14T12:00:00.000Z')`,
      [
        ledgerEntryId,
        `legacy:ledger:${ledgerEntryId}`,
        contractId,
        paymentTransactionId,
        installmentId,
      ],
    );
  } else {
    await pool.query(
      `insert into ledger_entry
         (id, contract_id, payment_transaction_id, installment_id, entry_type,
          direction, amount_minor_units, balance_after_minor_units, occurred_at)
       values ($1, $2, $3, $4, 'REPAYMENT', 'CREDIT', 10000, 90000,
               '2026-08-14T12:00:00.000Z')`,
      [ledgerEntryId, contractId, paymentTransactionId, installmentId],
    );
  }
  await pool.query(
    `insert into registration_record
       (vehicle_unit_id, registration_number, registered_owner, valid_from)
     values ($1, $2, $3, '2026-08-14')`,
    [vehicleUnitId, `REG-${suffix}`, options.registeredOwner],
  );

  return { contractId, installmentId, ledgerEntryId, paymentTransactionId };
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
