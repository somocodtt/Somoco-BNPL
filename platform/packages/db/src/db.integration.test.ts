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
import { completeInboxMessage, receiveInboxMessage } from "./inbox.js";
import { claimOutboxBatch, enqueueOutbox } from "./outbox.js";
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
      withTransaction(db, async (tx) =>
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
      receiveInboxMessage(db, event),
      receiveInboxMessage(db, event),
    ]);
    const owner = first.inserted ? first : duplicate;
    const observer = first.inserted ? duplicate : first;

    expect(duplicate.id).toBe(first.id);
    expect([first.inserted, duplicate.inserted].sort()).toEqual([false, true]);
    expect(owner.processingToken).toEqual(expect.any(String));
    expect(observer.processingToken).toBeNull();
    expect(await countRows(db, "inbox_message")).toBe(1);

    await completeInboxMessage(db, owner.id, owner.processingToken!, {
      accepted: true,
    });
    await expect(
      completeInboxMessage(db, owner.id, owner.processingToken!, {
        accepted: false,
      }),
    ).rejects.toThrow("INBOX_COMPLETION_NOT_OWNED");
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
      withTransaction(db, async (tx) => {
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
    const inserted = await withTransaction(db, (tx) =>
      applicationRepo(tx).insert(
        applicationBuilder({
          id: applicationId,
          applicantPersonId: personId,
        }),
        writeEffects(applicationId),
      ),
    );

    const updated = await withTransaction(db, (tx) =>
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
      withTransaction(db, (tx) =>
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

    await withTransaction(db, (tx) =>
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

    const first = await withTransaction(db, (tx) =>
      ledgerRepo(tx).append(entry, writeEffects(entryId, "LEDGER_POSTED")),
    );
    const duplicate = await withTransaction(db, (tx) =>
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

    const completed = await completeOwnershipTransfer(db, {
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
  db: Database,
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
