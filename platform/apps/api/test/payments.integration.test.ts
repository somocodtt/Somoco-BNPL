import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, migrateDatabase, type Database } from "@somo/db";
import { getInternalDatabase } from "../../../packages/db/src/client.js";
import { application } from "../../../packages/db/src/schema/applications.js";
import {
  contract,
  installment,
  repaymentSchedule,
} from "../../../packages/db/src/schema/contracts.js";
import { vehicleUnit } from "../../../packages/db/src/schema/assets.js";
import { offer, offerVersion } from "../../../packages/db/src/schema/offers.js";
import {
  financingRuleVersion,
  product,
  vehicleModel,
} from "../../../packages/db/src/schema/products.js";
import { person } from "../../../packages/db/src/schema/privacy.js";
import {
  staffRoleAssignment,
  staffUser,
} from "../../../packages/db/src/schema/access.js";
import type {
  CanonicalPaymentEvent,
  PaymentWebhookVerifier,
  SmsPort,
} from "@somo/integrations";
import { otpDerivationKeyId } from "@somo/integrations";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { resetTestDatabase } from "../../../packages/testkit/src/index.js";
import {
  createPaymentWebhookService,
  type AllocationPolicy,
} from "../src/modules/payments/webhook-service.js";
import { createLedgerService } from "../src/modules/payments/ledger-service.js";
import { createReconciliationService } from "../src/modules/payments/reconciliation-service.js";
import { createReceiptService } from "../src/modules/payments/receipt-service.js";
import type { CustomerPrincipal } from "../src/modules/access/policy.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) throw new Error("TEST_DATABASE_URL is required");

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 0,
  databaseUrl,
  allowedOrigins: ["https://staff.test.somo.example"],
  cookieName: "somo_staff_session",
  cookieSecret: "test-cookie-secret-with-at-least-32-characters",
  auditTargetHmacSecret: "test-audit-target-secret-with-at-least-32-characters",
  cookieSecure: false,
  bodyLimitBytes: 100_000,
  rateLimitMax: 100,
  rateLimitWindowMs: 60_000,
  sessionTtlSeconds: 3_600,
  argon2MemoryCostKiB: 19_456,
  argon2TimeCost: 2,
  argon2Parallelism: 1,
  requireVerifiedMfa: false,
};

const event: CanonicalPaymentEvent = Object.assign(
  {
    eventId: "evt-payment-1",
    eventType: "PAYMENT_SUCCEEDED" as const,
    providerTransactionId: "txn-payment-1",
    payerPhoneE164: "+233201234567",
    customerReference: "UNKNOWN-CUSTOMER-1",
    amount: { currency: "GHS" as const, minorUnits: "10000" },
    occurredAt: "2026-08-21T12:00:00.000Z",
  },
  { channel: "MOBILE_MONEY" as const },
);

function verifierFor(
  implementation: (input: {
    rawBody: Uint8Array;
    signature: string;
    requestTimestamp: string;
  }) => Promise<CanonicalPaymentEvent>,
): PaymentWebhookVerifier {
  return { verify: implementation };
}

function policy(): AllocationPolicy {
  return {
    version: "finance-policy-v1",
    policyHash: "a".repeat(64),
    workedExampleHash: "b".repeat(64),
    financeApprovedBy: "finance-approver-1",
    complianceApprovedBy: "compliance-approver-1",
    approvedBy: "finance-approver-1",
    approvedAt: "2026-08-01T00:00:00.000Z",
    decide: ({ amountMinorUnits }) => ({
      outcome: amountMinorUnits === 10_000n ? "MATCHED" : "QUARANTINED",
      allocations: [],
      ...(amountMinorUnits === 10_000n
        ? {}
        : { reason: "AMOUNT_REQUIRES_RECONCILIATION" }),
    }),
  };
}

describe("Somoco payment boundary", () => {
  let database: Database;
  let closeDatabase: () => Promise<void>;

  beforeAll(async () => {
    const connection = createDatabase(databaseUrl);
    database = connection.db;
    closeDatabase = connection.close;
  });

  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(database);
    await seedAllocationPolicy(database, policy());
  });

  afterAll(async () => {
    await closeDatabase();
  });

  it("verifies exact raw bytes before parsing and returns a durable stable acknowledgement", async () => {
    const raw = new Uint8Array(
      Buffer.from(
        '{"eventId":"evt-payment-1","amount":{"minorUnits":"10000"}}',
      ),
    );
    let observed: Uint8Array | undefined;
    const verifier = verifierFor(async (input) => {
      observed = input.rawBody;
      return event;
    });
    const service = createPaymentWebhookService({
      database,
      verifier,
      policy: policy(),
    });

    const first = await service.receive({
      rawBody: raw,
      signature: "sig",
      requestTimestamp: "2026-08-21T12:00:00.000Z",
    });
    const duplicate = await service.receive({
      rawBody: raw,
      signature: "sig",
      requestTimestamp: "2026-08-21T12:00:00.000Z",
    });

    expect(observed).toBeDefined();
    expect(Buffer.from(observed!)).toEqual(Buffer.from(raw));
    expect(first).toEqual(duplicate);
    expect(first).toMatchObject({
      eventId: event.eventId,
      accepted: true,
      duplicate: false,
    });
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from inbox_message`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it.each([
    ["invalid signature", "INVALID_SIGNATURE"],
    ["stale timestamp", "STALE_TIMESTAMP"],
    ["future timestamp", "FUTURE_TIMESTAMP"],
    ["unknown event", "UNKNOWN_EVENT"],
  ])("rejects %s before persistence", async (_name, code) => {
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => {
        throw new Error(code);
      }),
      policy: policy(),
    });
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("{}")),
        signature: "bad",
        requestTimestamp: "2026-08-21T12:00:00.000Z",
      }),
    ).rejects.toThrow(code);
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from inbox_message`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("quarantines a duplicate provider transaction without a second posting", async () => {
    const firstEvent = { ...event };
    const secondEvent = { ...event, eventId: "evt-payment-2" };
    let next = firstEvent;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => next),
      policy: policy(),
    });
    const first = await service.receive({
      rawBody: new Uint8Array(Buffer.from("first")),
      signature: "sig",
      requestTimestamp: "2026-08-21T12:00:00.000Z",
    });
    next = secondEvent;
    const second = await service.receive({
      rawBody: new Uint8Array(Buffer.from("second")),
      signature: "sig",
      requestTimestamp: "2026-08-21T12:00:00.000Z",
    });
    expect(first.accepted).toBe(true);
    expect(second).toMatchObject({ accepted: true, outcome: "QUARANTINED" });
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from payment_transaction`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("rolls back inbox and payment work together when posting fails", async () => {
    const contractReference = (await insertContractGraph(database)).reference;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: contractReference,
      })),
      policy: {
        ...policy(),
        decide: () => {
          throw new Error("POSTING_FAILURE");
        },
      },
    });
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("rollback")),
        signature: "sig",
        requestTimestamp: "2026-08-21T12:00:00.000Z",
      }),
    ).rejects.toThrow("POSTING_FAILURE");
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from inbox_message`,
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from payment_transaction`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("requires an approved allocation policy and exposes immutable ledger/reconciliation services", async () => {
    const ledger = createLedgerService({ database });
    await expect(
      ledger.post({
        contractReference: "missing-contract",
        providerTransactionId: "txn-ledger-1",
        amountMinorUnits: 10_000n,
        currency: "GHS",
        eventId: "evt-ledger-1",
        occurredAt: new Date("2026-08-21T12:00:00.000Z"),
      }),
    ).rejects.toThrow("ALLOCATION_POLICY_REQUIRED");
    expect(typeof ledger.reverse).toBe("function");
    expect(typeof ledger.requestAdjustment).toBe("function");
    const reconciliation = createReconciliationService({ database });
    expect(typeof reconciliation.compareSettlement).toBe("function");
  });

  it("posts one exact matched payment, issues one receipt, and reconciles the deposit gate", async () => {
    const graph = await insertContractGraph(database);
    const matchedPolicy: AllocationPolicy = {
      ...policy(),
      decide: ({ amountMinorUnits, installments }) => ({
        outcome: "MATCHED",
        allocations: [{ installmentId: installments[0]!.id, amountMinorUnits }],
      }),
    };
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: graph.reference,
      })),
      policy: matchedPolicy,
    });
    const result = await service.receive({
      rawBody: new Uint8Array(Buffer.from("matched")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    expect(result.outcome).toBe("POSTED");
    expect(result.receiptId).toEqual(expect.any(String));
    const internal = getInternalDatabase(database);
    expect(
      (
        await internal.execute<{ count: number }>(
          sql`select count(*)::int as count from ledger_entry`,
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await internal.execute<{ count: number }>(
          sql`select count(*)::int as count from payment_receipt`,
        )
      ).rows[0]?.count,
    ).toBe(1);
    expect(
      (
        await internal.execute<{ status: string; amount: string }>(
          sql`select status, amount_minor_units::text as amount from deposit_reconciliation`,
        )
      ).rows[0],
    ).toEqual({ status: "RECONCILED", amount: "10000" });
  });

  it("quarantines partial, excess, and ambiguous allocations instead of guessing", async () => {
    const graph = await insertContractGraph(database);
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: graph.reference,
        eventId: "evt-quarantine-1",
      })),
      policy: {
        ...policy(),
        decide: () => ({
          outcome: "QUARANTINED",
          allocations: [],
          reason: "AMOUNT_REQUIRES_RECONCILIATION",
        }),
      },
    });
    const result = await service.receive({
      rawBody: new Uint8Array(Buffer.from("quarantine")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    expect(result).toMatchObject({
      outcome: "QUARANTINED",
      reason: "AMOUNT_REQUIRES_RECONCILIATION",
    });
    const internal = getInternalDatabase(database);
    expect(
      (
        await internal.execute<{ count: number }>(
          sql`select count(*)::int as count from ledger_entry`,
        )
      ).rows[0]?.count,
    ).toBe(0);
    expect(
      (
        await internal.execute<{ reason: string }>(
          sql`select reason from reconciliation_case`,
        )
      ).rows[0]?.reason,
    ).toBe("AMOUNT_REQUIRES_RECONCILIATION");
  });

  it("links reversal compensation to the original immutable ledger entry", async () => {
    const graph = await insertContractGraph(database);
    const matchedPolicy: AllocationPolicy = {
      ...policy(),
      decide: ({ amountMinorUnits, installments }) => ({
        outcome: "MATCHED",
        allocations: [{ installmentId: installments[0]!.id, amountMinorUnits }],
      }),
    };
    let reversal = false;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () =>
        reversal
          ? {
              ...event,
              eventId: "evt-reversal-1",
              eventType: "PAYMENT_REVERSED",
              customerReference: graph.reference,
            }
          : { ...event, customerReference: graph.reference },
      ),
      policy: matchedPolicy,
    });
    await service.receive({
      rawBody: new Uint8Array(Buffer.from("original")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    reversal = true;
    const result = await service.receive({
      rawBody: new Uint8Array(Buffer.from("reversal")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    expect(result.outcome).toBe("REVERSED");
    const entries = await getInternalDatabase(database).execute<{
      entry_type: string;
      reverses_entry_id: string | null;
    }>(
      sql`select entry_type, reverses_entry_id from ledger_entry order by created_at`,
    );
    expect(entries.rows).toHaveLength(2);
    expect(entries.rows[1]?.entry_type).toBe("REVERSAL");
    expect(entries.rows[1]?.reverses_entry_id).toEqual(expect.any(String));
    expect(
      (
        await getInternalDatabase(database).execute<{
          outstanding: string;
          paid: string;
          status: string;
        }>(
          sql`select c.outstanding_balance_minor_units::text as outstanding, i.paid_minor_units::text as paid, p.status from contract c join installment i on i.contract_id = c.id join payment_transaction p on p.provider_transaction_id = ${event.providerTransactionId}`,
        )
      ).rows[0],
    ).toMatchObject({ outstanding: "100000", paid: "0", status: "REVERSED" });
    expect(
      (
        await getInternalDatabase(database).execute<{ status: string }>(
          sql`select status from deposit_reconciliation`,
        )
      ).rows[0],
    ).toEqual({ status: "REJECTED" });
  });

  it("requires separate maker and checker for adjustment decisions", async () => {
    const graph = await insertContractGraph(database);
    const makerId = await insertStaff(database, "FINANCE_OFFICER");
    const checkerId = await insertStaff(database, "CFO");
    const ledger = createLedgerService({ database });
    const pending = await ledger.requestAdjustment({
      contractId: graph.contractId,
      amountMinorUnits: 1000n,
      direction: "CREDIT",
      reason: "Correction",
      maker: {
        kind: "staff",
        staffUserId: makerId,
        roles: ["FINANCE_OFFICER"],
        sessionId: randomUUID(),
      },
      idempotencyKey: randomUUID(),
    });
    await expect(
      ledger.approveAdjustment({
        adjustmentId: pending.id,
        checker: {
          kind: "staff",
          staffUserId: makerId,
          roles: ["CFO"],
          sessionId: randomUUID(),
        },
        decision: "APPROVE",
        reason: "same person",
      }),
    ).rejects.toThrow("MAKER_CANNOT_CHECK");
    await expect(
      ledger.approveAdjustment({
        adjustmentId: pending.id,
        checker: {
          kind: "staff",
          staffUserId: checkerId,
          roles: ["CFO"],
          sessionId: randomUUID(),
        },
        decision: "APPROVE",
        reason: "approved",
      }),
    ).resolves.toMatchObject({ status: "APPROVED" });
    expect(
      (
        await getInternalDatabase(database).execute<{
          balance: string;
          entries: number;
        }>(
          sql`select c.outstanding_balance_minor_units::text as balance, (select count(*)::int from ledger_entry l where l.entry_type = 'ADJUSTMENT' and l.contract_id = c.id) as entries from contract c where c.id = ${graph.contractId}`,
        )
      ).rows[0],
    ).toEqual({ balance: "99000", entries: 1 });
    await expect(
      ledger.approveAdjustment({
        adjustmentId: pending.id,
        checker: {
          kind: "staff",
          staffUserId: checkerId,
          roles: ["CFO"],
          sessionId: randomUUID(),
        },
        decision: "APPROVE",
        reason: "replay",
      }),
    ).rejects.toThrow("PAYMENT_ADJUSTMENT_ALREADY_DECIDED");
  });

  it("persists matched and variance settlement cases", async () => {
    const reconciliation = createReconciliationService({ database });
    await expect(
      reconciliation.compareSettlement({
        settlementReference: "settle-empty",
        provider: "SOMOCO_PAYMENTS",
        providerTotalMinorUnits: 0n,
      }),
    ).resolves.toMatchObject({ status: "MATCHED", varianceMinorUnits: "0" });
    await expect(
      reconciliation.compareSettlement({
        settlementReference: "settle-variance",
        provider: "SOMOCO_PAYMENTS",
        providerTotalMinorUnits: 1000n,
      }),
    ).resolves.toMatchObject({
      status: "VARIANCE",
      varianceMinorUnits: "1000",
      reconciliationCaseId: expect.any(String),
    });
    const repeated = await reconciliation.compareSettlement({
      settlementReference: "settle-variance",
      provider: "SOMOCO_PAYMENTS",
      providerTotalMinorUnits: 1000n,
    });
    expect(repeated).toEqual(
      expect.objectContaining({
        id: expect.any(String),
        reconciliationCaseId: expect.any(String),
      }),
    );
    expect(repeated.id).toBe(
      (
        await reconciliation.compareSettlement({
          settlementReference: "settle-variance",
          provider: "SOMOCO_PAYMENTS",
          providerTotalMinorUnits: 1000n,
        })
      ).id,
    );
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from reconciliation_case where reason = 'SETTLEMENT_VARIANCE'`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("rejects an allocation policy without persisted Finance and Compliance approval evidence", async () => {
    const graph = await insertContractGraph(database);
    const unpersisted = {
      ...policy(),
      version: "unpersisted-policy-v9",
      decide: ({
        amountMinorUnits,
        installments,
      }: Parameters<AllocationPolicy["decide"]>[0]) => ({
        outcome: "MATCHED" as const,
        allocations: [{ installmentId: installments[0]!.id, amountMinorUnits }],
      }),
    } as AllocationPolicy;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: "evt-unpersisted-policy",
        customerReference: graph.reference,
      })),
      policy: unpersisted,
    });
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("unpersisted-policy")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).rejects.toThrow("ALLOCATION_POLICY_NOT_APPROVED");
  });

  it("serializes concurrent payment postings on the contract and installment rows", async () => {
    const graph = await insertContractGraph(database);
    const matchedPolicy: AllocationPolicy = {
      ...policy(),
      decide: ({ amountMinorUnits, installments }) => ({
        outcome: "MATCHED",
        allocations: [{ installmentId: installments[0]!.id, amountMinorUnits }],
      }),
    };
    let sequence = 0;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => {
        sequence += 1;
        return {
          ...event,
          eventId: `evt-concurrent-${sequence}`,
          providerTransactionId: `txn-concurrent-${sequence}`,
          customerReference: graph.reference,
          amount: { currency: "GHS", minorUnits: "60000" },
        };
      }),
      policy: matchedPolicy,
    });
    const results = await Promise.allSettled([
      service.receive({
        rawBody: new Uint8Array(Buffer.from("concurrent-1")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
      service.receive({
        rawBody: new Uint8Array(Buffer.from("concurrent-2")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      (
        await getInternalDatabase(database).execute<{
          balance: string;
          paid: string;
          entries: number;
        }>(
          sql`select c.outstanding_balance_minor_units::text as balance, i.paid_minor_units::text as paid, (select count(*)::int from ledger_entry l where l.contract_id = c.id and l.entry_type = 'REPAYMENT') as entries from contract c join installment i on i.contract_id = c.id where c.id = ${graph.contractId}`,
        )
      ).rows[0],
    ).toEqual({ balance: "40000", paid: "60000", entries: 1 });
  });

  it("fails closed when the canonical payment channel is missing or invalid", async () => {
    const graph = await insertContractGraph(database);
    const matchedPolicy: AllocationPolicy = {
      ...policy(),
      decide: ({ amountMinorUnits, installments }) => ({
        outcome: "MATCHED",
        allocations: [{ installmentId: installments[0]!.id, amountMinorUnits }],
      }),
    };
    const invalidChannel = {
      ...event,
      eventId: "evt-invalid-channel",
      customerReference: graph.reference,
      channel: "BANK_TRANSFER",
    } as unknown as CanonicalPaymentEvent;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => invalidChannel),
      policy: matchedPolicy,
    });
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("invalid-channel")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).rejects.toThrow("MALFORMED_PAYMENT_EVENT");
  });

  it("exposes zero-payment contract balance and due date separately from posted history", async () => {
    const graph = await insertContractGraph(database);
    const receipts = createReceiptService({
      database,
      accountLinkBaseUrl: "https://customer.somo.example/account",
      ussdInstructions: "Dial *123# and select Somoco Payments.",
    });
    const actor: CustomerPrincipal = {
      kind: "customer",
      customerAccountId: randomUUID(),
      personId: (
        await getInternalDatabase(database).execute<{ person_id: string }>(
          sql`select applicant_person_id as person_id from application where id = (select application_id from contract where id = ${graph.contractId})`,
        )
      ).rows[0]!.person_id,
      sessionId: randomUUID(),
    };
    await expect(receipts.listCustomerPayments(actor)).resolves.toEqual([]);
    await expect(receipts.listCustomerAccounts(actor)).resolves.toEqual([
      expect.objectContaining({
        contractReference: graph.reference,
        outstandingBalanceMinorUnits: "100000",
        nextDueDate: "2026-09-01",
      }),
    ]);
  });

  it("returns an authenticated receipt detail only to its customer", async () => {
    const graph = await insertContractGraph(database);
    const matchedPolicy: AllocationPolicy = {
      ...policy(),
      decide: ({ amountMinorUnits, installments }) => ({
        outcome: "MATCHED",
        allocations: [{ installmentId: installments[0]!.id, amountMinorUnits }],
      }),
    };
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: "evt-receipt-detail",
        customerReference: graph.reference,
      })),
      policy: matchedPolicy,
    });
    const result = await service.receive({
      rawBody: new Uint8Array(Buffer.from("receipt-detail")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    const receipts = createReceiptService({
      database,
      accountLinkBaseUrl: "https://customer.somo.example/account",
      ussdInstructions: "Dial *123# and select Somoco Payments.",
    }) as ReturnType<typeof createReceiptService> & {
      getCustomerReceipt(
        actor: CustomerPrincipal,
        receiptId: string,
      ): Promise<Record<string, unknown> | null>;
    };
    const actor: CustomerPrincipal = {
      kind: "customer",
      customerAccountId: randomUUID(),
      personId: (
        await getInternalDatabase(database).execute<{ person_id: string }>(
          sql`select applicant_person_id as person_id from application where id = (select application_id from contract where id = ${graph.contractId})`,
        )
      ).rows[0]!.person_id,
      sessionId: randomUUID(),
    };
    await expect(
      receipts.getCustomerReceipt(actor, result.receiptId!),
    ).resolves.toMatchObject({
      receiptNumber: expect.stringContaining("SOMO-"),
      paymentTransactionId: result.paymentTransactionId,
      status: "POSTED",
      securePath: expect.stringContaining(`/receipts/${result.receiptId}`),
    });
    await expect(
      receipts.getCustomerReceipt(
        { ...actor, personId: randomUUID() },
        result.receiptId!,
      ),
    ).resolves.toBeNull();
  });

  it("requires database reversal linkage and rejects unlinked reversal entries", async () => {
    const graph = await insertContractGraph(database);
    const internal = getInternalDatabase(database);
    await expect(
      internal.execute(sql`
        insert into ledger_entry
          (posting_key, contract_id, entry_type, direction, currency, amount_minor_units, balance_after_minor_units, occurred_at)
        values
          (${`unlinked-reversal-${randomUUID()}`}, ${graph.contractId}, 'REVERSAL', 'DEBIT', 'GHS', 1, 1, now())
      `),
    ).rejects.toThrow();
    await expect(
      internal.execute(sql`
        insert into ledger_entry
          (posting_key, contract_id, entry_type, direction, currency, amount_minor_units, balance_after_minor_units, reverses_entry_id, occurred_at)
        values
          (${`unknown-reversal-${randomUUID()}`}, ${graph.contractId}, 'REVERSAL', 'DEBIT', 'GHS', 1, 1, ${randomUUID()}, now())
      `),
    ).rejects.toThrow();
  });
});

async function seedAllocationPolicy(
  database: Database,
  approval: AllocationPolicy,
): Promise<void> {
  await getInternalDatabase(database).execute(sql`
    insert into payment_allocation_policy
      (version, policy_hash, worked_example_hash, worked_example,
       finance_approved_by, compliance_approved_by, approved_at, status)
    values
      (${approval.version}, ${approval.policyHash}, ${approval.workedExampleHash}, ${JSON.stringify(
        {
          version: approval.version,
          workedExample: "finance-approved-test-example",
        },
      )}::jsonb, ${approval.financeApprovedBy}, ${approval.complianceApprovedBy}, ${approval.approvedAt}, 'APPROVED')
  `);
}

async function insertContractGraph(
  database: Database,
): Promise<{ reference: string; contractId: string; installmentId: string }> {
  const db = getInternalDatabase(database);
  const suffix = randomUUID();
  const personId = randomUUID();
  const applicationId = randomUUID();
  const modelId = randomUUID();
  const productId = randomUUID();
  const ruleId = randomUUID();
  const offerId = randomUUID();
  const offerVersionId = randomUUID();
  const vehicleId = randomUUID();
  const contractId = randomUUID();
  const scheduleId = randomUUID();
  await db.insert(person).values({
    id: personId,
    phoneE164: `+23320${suffix.replaceAll("-", "").slice(0, 7)}`,
  });
  await db
    .insert(application)
    .values({ id: applicationId, applicantPersonId: personId });
  await db.insert(vehicleModel).values({
    id: modelId,
    manufacturer: "Somo",
    modelName: "Pilot",
    modelYear: 2026,
  });
  await db.insert(product).values({
    id: productId,
    code: `P-${suffix}`,
    name: "Pilot",
    vehicleModelId: modelId,
  });
  await db.insert(financingRuleVersion).values({
    id: ruleId,
    productId,
    versionNumber: 1,
    minimumDepositMinorUnits: 10_000n,
    annualRateBps: "0",
    allowedTenuresMonths: [12],
    repaymentFrequencies: ["MONTHLY"],
    calculationMethod: "FLAT_MARKUP",
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
    id: vehicleId,
    vehicleModelId: modelId,
    vin: `VIN-${suffix}`,
    chassisNumber: `CH-${suffix}`,
  });
  const reference = `CONTRACT-${suffix}`;
  await db.insert(contract).values({
    id: contractId,
    reference,
    applicationId,
    offerVersionId,
    vehicleUnitId: vehicleId,
    status: "ACTIVE",
    outstandingBalanceMinorUnits: 100_000n,
  });
  await db.insert(repaymentSchedule).values({
    id: scheduleId,
    contractId,
    versionNumber: 1,
    totalMinorUnits: 100_000n,
    firstDueDate: "2026-09-01",
  });
  const installmentId = randomUUID();
  await db.insert(installment).values({
    id: installmentId,
    contractId,
    repaymentScheduleId: scheduleId,
    installmentNumber: 1,
    dueDate: "2026-09-01",
    amountMinorUnits: 100_000n,
  });
  return { reference, contractId, installmentId };
}

async function insertStaff(
  database: Database,
  role: "FINANCE_OFFICER" | "CFO",
): Promise<string> {
  const db = getInternalDatabase(database);
  const id = randomUUID();
  await db
    .insert(staffUser)
    .values({ id, email: `${id}@example.test`, passwordHash: "test-hash" });
  await db.insert(staffRoleAssignment).values({ staffUserId: id, role });
  return id;
}

describe("payment HTTP composition", () => {
  let database: Database;
  let closeDatabase: () => Promise<void>;

  beforeAll(async () => {
    const connection = createDatabase(databaseUrl);
    database = connection.db;
    closeDatabase = connection.close;
  });
  beforeEach(async () => {
    await resetTestDatabase(databaseUrl);
    await migrateDatabase(database);
    await seedAllocationPolicy(database, policy());
  });
  afterAll(async () => {
    await closeDatabase();
  });

  it("exposes only Somoco payment webhook and no cash mutation path", async () => {
    const sms: SmsPort = {
      send: async () => ({
        providerReference: randomUUID(),
        acceptedAt: new Date().toISOString(),
      }),
    };
    const app = await buildApp({
      config,
      database,
      logger: false,
      identity: {
        sms,
        otpPolicy: {
          ttlMs: 120_000,
          attemptLimit: 3,
          resendCooldownMs: 30_000,
          codeLength: 6,
          hashSecret: "test-otp-hash-secret-with-at-least-32-characters",
          deliveryDerivationSecret:
            "test-delivery-secret-with-at-least-32-characters",
          deliveryDerivationKeyId: otpDerivationKeyId(
            "test-delivery-secret-with-at-least-32-characters",
          ),
          sessionTtlMs: 3_600_000,
        },
        consentCatalog: {
          documents: [
            {
              purpose: "NIA_IDENTITY_VERIFICATION",
              currentVersion: "nia-consent-v1",
            },
          ],
        },
      },
      payments: {
        verifier: verifierFor(async () => event),
        allocationPolicy: policy(),
        sms,
        accountLinkBaseUrl: "https://customer.somo.example/account",
        ussdInstructions: "Dial *123# and select Somoco Payments.",
      },
    });
    const webhook = await app.inject({
      method: "POST",
      url: "/v1/integrations/payments/somoco",
      headers: {
        "content-type": "application/json",
        "x-payment-signature": "sig",
        "x-payment-timestamp": "2026-08-21T12:00:00.000Z",
      },
      payload: JSON.stringify(event),
    });
    expect(webhook.statusCode).toBe(202);
    const malformed = await app.inject({
      method: "POST",
      url: "/v1/integrations/payments/somoco",
      headers: {
        "content-type": "application/json",
        "x-payment-signature": "sig",
        "x-payment-timestamp": "2026-08-21T12:00:00.000Z",
      },
      payload: '{"eventId":',
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({ code: "MALFORMED_JSON" });
    expect(
      app.hasRoute({
        method: "GET",
        url: "/v1/customer/receipts/:receiptId",
      }),
    ).toBe(true);
    expect(
      app.hasRoute({
        method: "POST",
        url: "/v1/staff/payments/reconciliation/:caseId/resolve",
      }),
    ).toBe(true);
    expect(
      app.hasRoute({
        method: "POST",
        url: "/v1/staff/payments/settlements/compare",
      }),
    ).toBe(true);
    const cash = await app.inject({
      method: "POST",
      url: "/v1/staff/payments/cash",
      payload: { amountMinorUnits: 100 },
    });
    expect(cash.statusCode).toBe(404);
    await app.close();
  });

  it("authenticates raw malformed bytes before JSON parsing", async () => {
    const sms: SmsPort = {
      send: async () => ({
        providerReference: randomUUID(),
        acceptedAt: new Date().toISOString(),
      }),
    };
    const app = await buildApp({
      config,
      database,
      logger: false,
      payments: {
        verifier: verifierFor(async () => {
          throw new Error("INVALID_SIGNATURE");
        }),
        allocationPolicy: policy(),
        sms,
        accountLinkBaseUrl: "https://customer.somo.example/account",
        ussdInstructions: "Dial *123# and select Somoco Payments.",
      },
    });
    const response = await app.inject({
      method: "POST",
      url: "/v1/integrations/payments/somoco",
      headers: {
        "content-type": "application/json",
        "x-payment-signature": "bad",
        "x-payment-timestamp": "2026-08-21T12:00:00.000Z",
      },
      payload: '{"eventId":',
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: "INVALID_SIGNATURE" });
    await app.close();
  });

  it("requires explicit approved USSD instructions in the payment composition", async () => {
    const sms: SmsPort = {
      send: async () => ({
        providerReference: randomUUID(),
        acceptedAt: new Date().toISOString(),
      }),
    };
    await expect(
      buildApp({
        config,
        database,
        logger: false,
        payments: {
          verifier: verifierFor(async () => event),
          allocationPolicy: policy(),
          sms,
          accountLinkBaseUrl: "https://customer.somo.example/account",
        },
      }),
    ).rejects.toThrow("PAYMENT_USSD_INSTRUCTIONS_REQUIRED");
  });
});
