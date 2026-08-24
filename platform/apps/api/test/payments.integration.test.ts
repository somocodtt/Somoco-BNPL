import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type Database,
} from "@somo/db";
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
import {
  paymentTransaction,
  reconciliationCase,
} from "../../../packages/db/src/schema/payments.js";
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
import {
  createProductionConnectorBoundary,
  otpDerivationKeyId,
} from "@somo/integrations";
import { sql } from "../../../packages/db/node_modules/drizzle-orm/index.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { resetTestDatabase } from "../../../packages/testkit/src/index.js";
import { createPaymentWebhookService } from "../src/modules/payments/webhook-service.js";
import {
  ALLOCATION_POLICY_BEHAVIOR_DIGEST,
  ALLOCATION_POLICY_EXECUTION_KEY,
  ALLOCATION_POLICY_VERSION,
  hashAllocationEvidenceArtifact,
  createLedgerService,
  type AllocationPolicy,
} from "../src/modules/payments/ledger-service.js";
import { createReconciliationService } from "../src/modules/payments/reconciliation-service.js";
import { createReceiptService } from "../src/modules/payments/receipt-service.js";
import { createSettlementService } from "../src/modules/contracts/settlement-service.js";
import type {
  CustomerPrincipal,
  StaffPrincipal,
  StaffRole,
} from "../src/modules/access/policy.js";

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
  const artifact = Object.freeze({
    externalArtifactId: "test-finance-compliance-evidence-v1",
    artifactRevision: 1,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
  });
  return Object.freeze({
    version: ALLOCATION_POLICY_VERSION,
    executionKey: ALLOCATION_POLICY_EXECUTION_KEY,
    behaviorDigest: ALLOCATION_POLICY_BEHAVIOR_DIGEST,
    evidence: Object.freeze({
      artifact,
      evidenceHash: hashAllocationEvidenceArtifact(artifact),
      financeApprovedBy: "test-finance-approver",
      complianceApprovedBy: "test-compliance-approver",
      financeSignature: "test-finance-signature",
      complianceSignature: "test-compliance-signature",
      financeApprovedAt: "2026-08-01T00:00:00.000Z",
      complianceApprovedAt: "2026-08-01T01:00:00.000Z",
    }),
  });
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

  it("rejects a verified payment amount above signed bigint storage before persistence", async () => {
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: "evt-payment-overflow",
        providerTransactionId: "txn-payment-overflow",
        amount: { currency: "GHS", minorUnits: "9223372036854775808" },
      })),
      policy: policy(),
    });

    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("payment-overflow")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).rejects.toMatchObject({ code: "MALFORMED_PAYMENT_EVENT" });
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from inbox_message`,
        )
      ).rows[0]?.count,
    ).toBe(0);
  });

  it("preserves a nested production transport outage and posts recovery once", async () => {
    const graph = await insertContractGraph(database);
    const outageEvent: CanonicalPaymentEvent = {
      ...event,
      eventId: "evt-nested-production-outage",
      providerTransactionId: "txn-nested-production-outage",
      customerReference: graph.reference,
    };
    let paymentAvailable = false;
    const verifier = createProductionConnectorBoundary().register({
      kind: "PAYMENTS",
      provenance: {
        packageName: "@somo-external/somoco-payments",
        packageVersion: "1.0.0",
        connectorId: "somoco-payments",
      },
      adapter: {
        async verify() {
          if (!paymentAvailable) {
            throw new TypeError("fetch failed", {
              cause: { code: "ECONNRESET" },
            });
          }
          return outageEvent;
        },
      },
    });
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
        verifier,
        allocationPolicy: policy(),
        sms,
        accountLinkBaseUrl: "https://customer.somo.example/account",
        ussdInstructions: "Dial *123# and select Somoco Payments.",
      },
    });
    const rawBody = JSON.stringify(outageEvent);
    const request = {
      method: "POST" as const,
      url: "/v1/integrations/payments/somoco",
      headers: {
        "content-type": "application/json",
        "x-payment-signature": "nested-outage-signature",
        "x-payment-timestamp": outageEvent.occurredAt,
      },
      payload: rawBody,
    };

    try {
      const outage = await app.inject(request);
      expect(outage.statusCode).toBe(503);
      expect(outage.json()).toMatchObject({
        code: "PAYMENT_PROVIDER_UNAVAILABLE",
      });
      const preserved = await getInternalDatabase(database).execute<{
        payment_count: number;
        processed_count: number;
        raw_body_base64: string | null;
      }>(sql`
        select
          (select count(*)::int
             from payment_transaction
            where provider_transaction_id = ${outageEvent.providerTransactionId}) as payment_count,
          (select count(*)::int
             from inbox_message
            where provider = 'SOMOCO_PAYMENTS'
              and provider_event_id like 'unverified:sha256:%'
              and processed_at is not null) as processed_count,
          (select payload->>'rawBodyBase64'
             from inbox_message
            where provider = 'SOMOCO_PAYMENTS'
              and provider_event_id like 'unverified:sha256:%') as raw_body_base64
      `);
      expect(preserved.rows[0]).toEqual({
        payment_count: 0,
        processed_count: 0,
        raw_body_base64: Buffer.from(rawBody).toString("base64"),
      });

      paymentAvailable = true;
      const recovered = await app.inject(request);
      expect(recovered.statusCode).toBe(202);
      expect(recovered.json()).toMatchObject({
        accepted: true,
        duplicate: false,
        outcome: "POSTED",
      });
      const replay = await app.inject(request);
      expect(replay.statusCode).toBe(202);
      expect(replay.json()).toMatchObject({
        accepted: true,
        outcome: "POSTED",
      });
      const recoveredEvidence = await getInternalDatabase(database).execute<{
        payment_count: number;
        receipt_count: number;
        credit_ledger_count: number;
        processed_count: number;
      }>(sql`
        select
          (select count(*)::int
             from payment_transaction
            where provider_transaction_id = ${outageEvent.providerTransactionId}) as payment_count,
          (select count(*)::int
             from payment_receipt r
             join payment_transaction p on p.id = r.payment_transaction_id
            where p.provider_transaction_id = ${outageEvent.providerTransactionId}) as receipt_count,
          (select count(*)::int
             from ledger_entry l
             join payment_transaction p on p.id = l.payment_transaction_id
            where p.provider_transaction_id = ${outageEvent.providerTransactionId}
              and l.direction = 'CREDIT') as credit_ledger_count,
          (select count(*)::int
             from inbox_message
            where provider = 'SOMOCO_PAYMENTS'
              and provider_event_id = ${outageEvent.eventId}
              and processed_at is not null) as processed_count
      `);
      expect(recoveredEvidence.rows[0]).toEqual({
        payment_count: 1,
        receipt_count: 1,
        credit_ledger_count: 1,
        processed_count: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("keeps attacker outage fields non-canonical and links verified recovery exactly once", async () => {
    const graph = await insertContractGraph(database);
    const canonical: CanonicalPaymentEvent = {
      ...event,
      eventId: "evt-adversarial-outage-canonical",
      eventType: "PAYMENT_SUCCEEDED",
      providerTransactionId: "txn-adversarial-outage-canonical",
      customerReference: graph.reference,
    };
    const attackerBody = JSON.stringify({
      eventId: canonical.eventId,
      eventType: "PAYMENT_REFUNDED",
      providerTransactionId: "txn-attacker-controlled",
      customerReference: "ATTACKER-CONTROLLED",
      amount: { currency: "GHS", minorUnits: "9223372036854775807" },
    });
    let available = false;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => {
        if (!available)
          throw Object.assign(new Error("network down"), {
            code: "ECONNRESET",
          });
        return canonical;
      }),
      policy: policy(),
    });
    const input = {
      rawBody: new Uint8Array(Buffer.from(attackerBody)),
      signature: "adversarial-outage-signature",
      requestTimestamp: canonical.occurredAt,
    };

    await expect(service.receive(input)).rejects.toMatchObject({
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
    });
    available = true;
    await expect(service.receive(input)).resolves.toMatchObject({
      eventId: canonical.eventId,
      outcome: "POSTED",
      duplicate: false,
    });
    await expect(service.receive(input)).resolves.toMatchObject({
      eventId: canonical.eventId,
      outcome: "POSTED",
    });

    const evidence = await getInternalDatabase(database).execute<{
      provider_event_id: string;
      event_type: string;
      provider_transaction_id: string | null;
      preservation_message_id: string | null;
    }>(sql`
      select provider_event_id, event_type,
             payload->>'providerTransactionId' as provider_transaction_id,
             preservation_message_id::text
        from inbox_message
       where provider = 'SOMOCO_PAYMENTS'
       order by provider_event_id
    `);
    expect(evidence.rows).toHaveLength(2);
    const preservation = evidence.rows.find((row) =>
      row.provider_event_id.startsWith("unverified:sha256:"),
    );
    const verified = evidence.rows.find(
      (row) => row.provider_event_id === canonical.eventId,
    );
    expect(preservation).toMatchObject({
      event_type: "PAYMENT_VERIFICATION_UNAVAILABLE",
      provider_transaction_id: null,
      preservation_message_id: null,
    });
    expect(verified).toMatchObject({
      event_type: "PAYMENT_SUCCEEDED",
      provider_transaction_id: canonical.providerTransactionId,
      preservation_message_id: expect.any(String),
    });
    expect(verified?.preservation_message_id).toBe(
      (
        await getInternalDatabase(database).execute<{ id: string }>(sql`
          select id::text from inbox_message
           where provider_event_id like 'unverified:sha256:%'
        `)
      ).rows[0]?.id,
    );
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(sql`
          select count(*)::int as count
            from ledger_entry l
            join payment_transaction p on p.id = l.payment_transaction_id
           where p.provider_transaction_id = ${canonical.providerTransactionId}
        `)
      ).rows[0]?.count,
    ).toBe(1);
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
    const graph = await insertContractGraph(database);
    await getInternalDatabase(database).execute(sql`
      update contract
         set outstanding_balance_minor_units = 5000
       where id = ${graph.contractId}
    `);
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: graph.reference,
      })),
      policy: policy(),
    });
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("rollback")),
        signature: "sig",
        requestTimestamp: "2026-08-21T12:00:00.000Z",
      }),
    ).rejects.toThrow("CONTRACT_BALANCE_EXCEEDED");
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

  it("rejects a persisted allocation worked example whose canonical hash no longer matches", async () => {
    const graph = await insertContractGraph(database);
    await getInternalDatabase(database).execute(sql`
      update payment_allocation_policy
         set worked_example = '{"tampered":true}'::jsonb
       where version = 'finance-policy-v1'
    `);
    const matchedPolicy = policy();
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: graph.reference,
      })),
      policy: matchedPolicy,
    });
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("tampered-policy")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).rejects.toThrow("ALLOCATION_POLICY_NOT_APPROVED");
  });

  it("rejects a persisted allocation policy when its executable behavior digest differs", async () => {
    const graph = await insertContractGraph(database);
    await getInternalDatabase(database).execute(sql`
      update payment_allocation_policy
         set behavior_digest = ${"0".repeat(64)}
       where version = 'finance-policy-v1'
    `);
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: graph.reference,
      })),
      policy: policy(),
    });
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("behavior-digest-mismatch")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).rejects.toThrow("ALLOCATION_POLICY_NOT_APPROVED");
  });

  it("fails closed when the external signed worked-example evidence is missing or mismatched", async () => {
    const graph = await insertContractGraph(database);
    const missingEvidence = {
      ...policy(),
      evidence: undefined,
    } as unknown as AllocationPolicy;
    expect(() =>
      createPaymentWebhookService({
        database,
        verifier: verifierFor(async () => ({
          ...event,
          customerReference: graph.reference,
        })),
        policy: missingEvidence,
      }),
    ).toThrow("ALLOCATION_POLICY_INVALID");
    const mismatchedEvidence = {
      ...policy(),
      evidence: {
        ...policy().evidence,
        artifact: { externalArtifactId: "wrong" },
      },
    } as unknown as AllocationPolicy;
    expect(() =>
      createPaymentWebhookService({
        database,
        verifier: verifierFor(async () => ({
          ...event,
          customerReference: graph.reference,
        })),
        policy: mismatchedEvidence,
      }),
    ).toThrow("ALLOCATION_POLICY_INVALID");
  });

  it("rejects caller-supplied allocation behavior at production composition", async () => {
    const injected = {
      ...policy(),
      decide: () => ({ outcome: "MATCHED", allocations: [] }),
    } as unknown as AllocationPolicy;
    expect(() =>
      createPaymentWebhookService({
        database,
        verifier: verifierFor(async () => event),
        policy: injected,
      }),
    ).toThrow("ALLOCATION_POLICY_INVALID");
  });

  it("rejects caller-supplied executable allocation behavior", async () => {
    const injected = {
      ...policy(),
      decide: () => ({ outcome: "MATCHED", allocations: [] }),
    } as unknown as AllocationPolicy;
    expect(() =>
      createPaymentWebhookService({
        database,
        verifier: verifierFor(async () => event),
        policy: injected,
      }),
    ).toThrow("ALLOCATION_POLICY_INVALID");
  });

  it("requires a trusted verifier for canonical signed allocation evidence", async () => {
    const graph = await insertContractGraph(database);
    const approved = policy();
    let calls = 0;
    let verifiedInput: unknown;
    const evidenceVerifier = {
      verify: async (input: unknown) => {
        calls += 1;
        verifiedInput = input;
        return { attestationReference: "test-attestation-1" };
      },
    };
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: graph.reference,
      })),
      policy: approved,
      evidenceVerifier,
    } as unknown as Parameters<typeof createPaymentWebhookService>[0]);
    const result = await service.receive({
      rawBody: new Uint8Array(Buffer.from("attested-policy")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    expect(result.outcome).toBe("POSTED");
    expect(calls).toBe(1);
    expect(verifiedInput).toMatchObject({
      signedBytes: expect.any(Uint8Array),
      evidence: {
        artifactHash: approved.evidence.evidenceHash,
        financeApprovedBy: approved.evidence.financeApprovedBy,
        complianceApprovedBy: approved.evidence.complianceApprovedBy,
        financeApprovedAt: approved.evidence.financeApprovedAt,
        complianceApprovedAt: approved.evidence.complianceApprovedAt,
        policyVersion: approved.version,
        executionKey: approved.executionKey,
        allocationEngineDigest: approved.behaviorDigest,
      },
    });
    const signedDocument = JSON.parse(
      new TextDecoder().decode(
        (verifiedInput as { signedBytes: Uint8Array }).signedBytes,
      ),
    ) as Record<string, string>;
    expect(signedDocument).toEqual({
      allocationEngineDigest: approved.behaviorDigest,
      artifactHash: approved.evidence.evidenceHash,
      complianceApprovedAt: approved.evidence.complianceApprovedAt,
      complianceApprovedBy: approved.evidence.complianceApprovedBy,
      executionKey: approved.executionKey,
      financeApprovedAt: approved.evidence.financeApprovedAt,
      financeApprovedBy: approved.evidence.financeApprovedBy,
      policyVersion: approved.version,
      schema: "SOMOCO_ALLOCATION_POLICY_EVIDENCE_V1",
    });
    const metadataRows = await getInternalDatabase(database).execute<{
      metadata: Record<string, unknown>;
    }>(sql`
      select metadata
        from ledger_entry
       where posting_key like ${`${event.providerTransactionId}:%`}
    `);
    expect(metadataRows.rows[0]?.metadata.policyAttestationReference).toBe(
      "test-attestation-1",
    );
  });

  it("fails closed on untrusted or swapped allocation evidence", async () => {
    const graph = await insertContractGraph(database);
    const rejected = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        customerReference: graph.reference,
      })),
      policy: policy(),
      evidenceVerifier: {
        verify: async () => {
          throw new Error("UNTRUSTED_SIGNATURE");
        },
      },
    } as unknown as Parameters<typeof createPaymentWebhookService>[0]);
    await expect(
      rejected.receive({
        rawBody: new Uint8Array(Buffer.from("untrusted-policy")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).rejects.toThrow("ALLOCATION_POLICY_EVIDENCE_NOT_VERIFIED");

    const swapped = policy();
    const swappedService = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: "evt-swapped-policy",
        providerTransactionId: "txn-swapped-policy",
        customerReference: graph.reference,
      })),
      policy: swapped,
      evidenceVerifier: {
        verify: async (input: { evidence: { financeApprovedBy: string } }) => {
          if (input.evidence.financeApprovedBy !== "expected-finance")
            throw new Error("EVIDENCE_BINDING_INVALID");
          return { attestationReference: "wrong-signers" };
        },
      },
    } as unknown as Parameters<typeof createPaymentWebhookService>[0]);
    await expect(
      swappedService.receive({
        rawBody: new Uint8Array(Buffer.from("swapped-policy")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).rejects.toThrow("ALLOCATION_POLICY_EVIDENCE_NOT_VERIFIED");
  });

  it("binds the attestation to the exact allocation engine digest and reuses it for replay", async () => {
    const graph = await insertContractGraph(database);
    const approved = policy();
    let calls = 0;
    const evidenceVerifier = {
      verify: async (input: {
        evidence: { allocationEngineDigest: string };
        signedBytes: Uint8Array;
      }) => {
        calls += 1;
        expect(input.evidence.allocationEngineDigest).toBe(
          approved.behaviorDigest,
        );
        expect(new TextDecoder().decode(input.signedBytes)).toContain(
          approved.behaviorDigest,
        );
        return { attestationReference: "test-attestation-replay" };
      },
    };
    let replay = false;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: replay ? "evt-attested-replay" : "evt-attested-original",
        providerTransactionId: "txn-attested-replay",
        customerReference: graph.reference,
      })),
      policy: approved,
      evidenceVerifier,
    } as unknown as Parameters<typeof createPaymentWebhookService>[0]);
    await service.receive({
      rawBody: new Uint8Array(Buffer.from("attested-original")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    await getInternalDatabase(database).execute(sql`
      update payment_allocation_policy
         set status = 'REVOKED'
       where version = 'finance-policy-v1'
    `);
    replay = true;
    const duplicate = await service.receive({
      rawBody: new Uint8Array(Buffer.from("attested-replay")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(calls).toBe(1);
  });

  it("replays a committed provider payment without a fresh policy verifier", async () => {
    const graph = await insertContractGraph(database);
    const approved = policy();
    const firstService = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: "evt-fresh-replay-original",
        providerTransactionId: "txn-fresh-replay",
        customerReference: graph.reference,
      })),
      policy: approved,
      evidenceVerifier: {
        verify: async () => ({
          attestationReference: "fresh-replay-attestation",
        }),
      },
    } as unknown as Parameters<typeof createPaymentWebhookService>[0]);
    const first = await firstService.receive({
      rawBody: new Uint8Array(Buffer.from("fresh-replay-original")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    expect(first.outcome).toBe("POSTED");
    await getInternalDatabase(database).execute(sql`
      update payment_allocation_policy
         set status = 'REVOKED'
       where version = 'finance-policy-v1'
    `);

    let verifierCalls = 0;
    const freshService = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: "evt-fresh-replay-new",
        providerTransactionId: "txn-fresh-replay",
        customerReference: graph.reference,
      })),
      policy: approved,
      evidenceVerifier: {
        verify: async () => {
          verifierCalls += 1;
          throw new Error("EVIDENCE_PROVIDER_UNAVAILABLE");
        },
      },
    } as unknown as Parameters<typeof createPaymentWebhookService>[0]);
    const replay = await freshService.receive({
      rawBody: new Uint8Array(Buffer.from("fresh-replay-new")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });

    expect(replay).toMatchObject({
      accepted: true,
      duplicate: true,
      outcome: first.outcome,
      paymentTransactionId: first.paymentTransactionId,
    });
    expect(verifierCalls).toBe(0);
  });

  it("returns one stable result for concurrent events sharing a provider transaction id", async () => {
    const graph = await insertContractGraph(database);
    let sequence = 0;
    const matchedPolicy = policy();
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => {
        sequence += 1;
        return {
          ...event,
          eventId: `evt-same-provider-${sequence}`,
          providerTransactionId: "txn-same-provider",
          customerReference: graph.reference,
        };
      }),
      policy: matchedPolicy,
    });
    const results = await Promise.all([
      service.receive({
        rawBody: new Uint8Array(Buffer.from("same-provider-1")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
      service.receive({
        rawBody: new Uint8Array(Buffer.from("same-provider-2")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]?.paymentTransactionId).toBe(
      results[1]?.paymentTransactionId,
    );
    expect(results[0]?.outcome).toBe("POSTED");
    expect(results[1]?.outcome).toBe("POSTED");
    expect(results.map((result) => result.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from payment_transaction`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("acknowledges a posted replay even after the allocation policy is revoked", async () => {
    const graph = await insertContractGraph(database);
    const matchedPolicy = policy();
    let replay = false;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: replay ? "evt-revoked-replay" : event.eventId,
        customerReference: graph.reference,
      })),
      policy: matchedPolicy,
    });
    const first = await service.receive({
      rawBody: new Uint8Array(Buffer.from("revoked-first")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    await getInternalDatabase(database).execute(sql`
      update payment_allocation_policy
         set status = 'REVOKED'
       where version = 'finance-policy-v1'
    `);
    replay = true;
    const repeated = await service.receive({
      rawBody: new Uint8Array(Buffer.from("revoked-replay")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    expect(repeated).toMatchObject({
      accepted: true,
      outcome: "POSTED",
      paymentTransactionId: first.paymentTransactionId,
    });
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
    const matchedPolicy = policy();
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
        amount: { currency: "GHS", minorUnits: "5000" },
      })),
      policy: policy(),
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
    const matchedPolicy = policy();
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

  it("replays concurrent reversal events by provider transaction without a second compensation", async () => {
    const graph = await insertContractGraph(database);
    let reversal = false;
    let reversalSequence = 0;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => {
        if (!reversal)
          return {
            ...event,
            eventId: "evt-reversal-race-original",
            providerTransactionId: "txn-reversal-race",
            customerReference: graph.reference,
          };
        reversalSequence += 1;
        return {
          ...event,
          eventId: `evt-reversal-race-${reversalSequence}`,
          eventType: "PAYMENT_REVERSED" as const,
          providerTransactionId: "txn-reversal-race",
          customerReference: graph.reference,
        };
      }),
      policy: policy(),
    });
    const original = await service.receive({
      rawBody: new Uint8Array(Buffer.from("reversal-race-original")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    await getInternalDatabase(database).execute(sql`
      update payment_allocation_policy
         set status = 'REVOKED'
       where version = 'finance-policy-v1'
    `);
    reversal = true;
    const results = await Promise.all([
      service.receive({
        rawBody: new Uint8Array(Buffer.from("reversal-race-1")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
      service.receive({
        rawBody: new Uint8Array(Buffer.from("reversal-race-2")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ]);
    expect(original.outcome).toBe("POSTED");
    expect(results.map((result) => result.outcome)).toEqual([
      "REVERSED",
      "REVERSED",
    ]);
    expect(results[0]?.paymentTransactionId).toBe(
      results[1]?.paymentTransactionId,
    );
    expect(results.map((result) => result.duplicate).sort()).toEqual([
      false,
      true,
    ]);
    const internal = getInternalDatabase(database);
    expect(
      (
        await internal.execute<{ count: number }>(
          sql`select count(*)::int as count from payment_transaction`,
        )
      ).rows[0]?.count,
    ).toBe(2);
    expect(
      (
        await internal.execute<{ count: number }>(
          sql`select count(*)::int as count from ledger_entry`,
        )
      ).rows[0]?.count,
    ).toBe(2);
  });

  it("treats reversal and refund notifications as one compensation lifecycle", async () => {
    const graph = await insertContractGraph(database);
    let notification: "ORIGINAL" | "REVERSAL" | "REFUND" = "ORIGINAL";
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId:
          notification === "ORIGINAL"
            ? "evt-one-compensation-original"
            : notification === "REVERSAL"
              ? "evt-one-compensation-reversal"
              : "evt-one-compensation-refund",
        eventType:
          notification === "ORIGINAL"
            ? "PAYMENT_SUCCEEDED"
            : notification === "REVERSAL"
              ? "PAYMENT_REVERSED"
              : "PAYMENT_REFUNDED",
        providerTransactionId: "txn-one-compensation",
        customerReference: graph.reference,
      })),
      policy: policy(),
    });

    await service.receive({
      rawBody: new Uint8Array(Buffer.from("one-compensation-original")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    notification = "REVERSAL";
    const reversal = await service.receive({
      rawBody: new Uint8Array(Buffer.from("one-compensation-reversal")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    notification = "REFUND";
    const refund = await service.receive({
      rawBody: new Uint8Array(Buffer.from("one-compensation-refund")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });

    expect(reversal.duplicate).toBe(false);
    expect(refund).toMatchObject({
      duplicate: true,
      paymentTransactionId: reversal.paymentTransactionId,
    });
    expect(
      await getInternalDatabase(database).execute<{
        payments: number;
        compensations: number;
        balance: string;
      }>(sql`
        select (select count(*)::int from payment_transaction) as payments,
               (select count(*)::int from ledger_entry where reverses_entry_id is not null) as compensations,
               (select outstanding_balance_minor_units::text from contract where id = ${graph.contractId}) as balance
      `),
    ).toMatchObject({
      rows: [{ payments: 2, compensations: 1, balance: "100000" }],
    });
  });

  it("allows a resolved reversal plus replacement payment to settle", async () => {
    const graph = await insertContractGraph(database);
    let phase: "ORIGINAL" | "REVERSAL" | "REPLACEMENT" = "ORIGINAL";
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: `evt-replacement-${phase.toLowerCase()}`,
        eventType:
          phase === "REVERSAL" ? "PAYMENT_REVERSED" : "PAYMENT_SUCCEEDED",
        providerTransactionId:
          phase === "REPLACEMENT"
            ? "txn-replacement-new"
            : "txn-replacement-original",
        customerReference: graph.reference,
        amount: { currency: "GHS", minorUnits: "100000" },
      })),
      policy: policy(),
    });
    for (const next of ["ORIGINAL", "REVERSAL", "REPLACEMENT"] as const) {
      phase = next;
      await service.receive({
        rawBody: new Uint8Array(Buffer.from(`replacement-${next}`)),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      });
    }

    const settled = await settlePaymentFixture(database, graph.contractId);
    expect(settled).toMatchObject({ status: "SETTLED" });
  });

  it("quarantines post-settlement reversals and adjustments without reopening the contract", async () => {
    const graph = await insertContractGraph(database);
    let reversal = false;
    const service = createPaymentWebhookService({
      database,
      verifier: verifierFor(async () => ({
        ...event,
        eventId: reversal
          ? "evt-post-settlement-reversal"
          : "evt-post-settlement-original",
        eventType: reversal ? "PAYMENT_REVERSED" : "PAYMENT_SUCCEEDED",
        providerTransactionId: "txn-post-settlement",
        customerReference: graph.reference,
        amount: { currency: "GHS", minorUnits: "100000" },
      })),
      policy: policy(),
    });
    await service.receive({
      rawBody: new Uint8Array(Buffer.from("post-settlement-original")),
      signature: "sig",
      requestTimestamp: event.occurredAt,
    });
    await settlePaymentFixture(database, graph.contractId);

    reversal = true;
    await expect(
      service.receive({
        rawBody: new Uint8Array(Buffer.from("post-settlement-reversal")),
        signature: "sig",
        requestTimestamp: event.occurredAt,
      }),
    ).resolves.toMatchObject({
      outcome: "QUARANTINED",
      reason: "POST_SETTLEMENT_REVERSAL_REQUIRES_EXCEPTION",
    });

    const maker = await insertStaff(database, "FINANCE_OFFICER");
    const checker = await insertStaff(database, "COMPLIANCE_OFFICER");
    const ledger = createLedgerService({ database });
    const adjustment = await ledger.requestAdjustment({
      contractId: graph.contractId,
      amountMinorUnits: 1_000n,
      direction: "DEBIT",
      reason: "Late provider correction",
      maker: staffPrincipal(maker, "FINANCE_OFFICER"),
      idempotencyKey: "post-settlement-adjustment",
    });
    await expect(
      ledger.approveAdjustment({
        adjustmentId: adjustment.id,
        checker: staffPrincipal(checker, "COMPLIANCE_OFFICER"),
        decision: "APPROVE",
        reason: "Escalate to human exception",
      }),
    ).resolves.toMatchObject({ status: "QUARANTINED" });

    const state = await getInternalDatabase(database).execute<{
      status: string;
      balance: string;
      ledger_count: number;
      open_cases: number;
    }>(sql`
      select c.status,
             c.outstanding_balance_minor_units::text as balance,
             (select count(*)::int from ledger_entry l where l.contract_id = c.id) as ledger_count,
             (select count(*)::int from reconciliation_case rc
               left join payment_transaction p on p.id = rc.payment_transaction_id
              where rc.status <> 'RESOLVED'
                and (p.contract_id = c.id or rc.dedupe_key = ${`POST_SETTLEMENT_ADJUSTMENT:${adjustment.id}`})) as open_cases
        from contract c where c.id = ${graph.contractId}
    `);
    expect(state.rows[0]).toEqual({
      status: "SETTLED",
      balance: "0",
      ledger_count: 1,
      open_cases: 2,
    });
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

  it("keeps auditor and system admin read-only while a compliance officer checks an adjustment", async () => {
    const graph = await insertContractGraph(database);
    const makerId = await insertStaff(database, "FINANCE_OFFICER");
    const checkerId = await insertStaff(database, "CFO");
    const ledger = createLedgerService({ database });
    const pending = await ledger.requestAdjustment({
      contractId: graph.contractId,
      amountMinorUnits: 1_000n,
      direction: "CREDIT",
      reason: "Correct an independently verified allocation",
      maker: {
        kind: "staff",
        staffUserId: makerId,
        roles: ["FINANCE_OFFICER"],
        sessionId: randomUUID(),
      },
      idempotencyKey: randomUUID(),
    });

    for (const role of ["COMPLIANCE_AUDITOR", "SYSTEM_ADMIN"] as StaffRole[]) {
      await expect(
        ledger.approveAdjustment({
          adjustmentId: pending.id,
          checker: {
            kind: "staff",
            staffUserId: checkerId,
            roles: [role],
            sessionId: randomUUID(),
          },
          decision: "APPROVE",
          reason: "Read-only role must not post an adjustment",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }

    await expect(
      ledger.approveAdjustment({
        adjustmentId: pending.id,
        checker: {
          kind: "staff",
          staffUserId: checkerId,
          roles: ["COMPLIANCE_OFFICER" as StaffRole],
          sessionId: randomUUID(),
        },
        decision: "APPROVE",
        reason: "Independent compliance review completed",
      }),
    ).resolves.toMatchObject({ status: "APPROVED" });
  });

  it("persists matched and variance settlement cases", async () => {
    const staffUserId = await insertStaff(database, "FINANCE_OFFICER");
    const actor: StaffPrincipal = {
      kind: "staff",
      staffUserId,
      roles: ["FINANCE_OFFICER"],
      sessionId: randomUUID(),
    };
    const reconciliation = createReconciliationService({ database });
    await expect(
      reconciliation.compareSettlement({
        settlementReference: "settle-empty",
        provider: "SOMOCO_PAYMENTS",
        providerTotalMinorUnits: 0n,
        actor,
      }),
    ).resolves.toMatchObject({ status: "MATCHED", varianceMinorUnits: "0" });
    await expect(
      reconciliation.compareSettlement({
        settlementReference: "settle-variance",
        provider: "SOMOCO_PAYMENTS",
        providerTotalMinorUnits: 1000n,
        actor,
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
      actor,
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
          actor,
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
    const approved = policy();
    const unpersisted = {
      ...approved,
      evidence: {
        ...approved.evidence,
        financeApprovedAt: "2026-08-02T00:00:00.000Z",
      },
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
    const matchedPolicy = policy();
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
          amount: { currency: "GHS", minorUnits: "100000" },
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
    ).toHaveLength(2);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(0);
    expect(
      results
        .filter((result) => result.status === "fulfilled")
        .map((result) => result.value.outcome)
        .sort(),
    ).toEqual(["POSTED", "QUARANTINED"]);
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
    ).toEqual({ balance: "0", paid: "100000", entries: 1 });
  });

  it("fails closed when the canonical payment channel is missing or invalid", async () => {
    const graph = await insertContractGraph(database);
    const matchedPolicy = policy();
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
    const matchedPolicy = policy();
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

  it("issues one persisted receipt and one receipt notification under concurrency", async () => {
    const graph = await insertContractGraph(database);
    const paymentId = randomUUID();
    const payment = await getInternalDatabase(database)
      .insert(paymentTransaction)
      .values({
        id: paymentId,
        provider: "SOMOCO_PAYMENTS",
        channel: "USSD",
        providerTransactionId: `txn-receipt-concurrent-${paymentId}`,
        eventId: `evt-receipt-concurrent-${paymentId}`,
        eventType: "PAYMENT_SUCCEEDED",
        contractId: graph.contractId,
        payerReference: "+233201234567",
        currency: "GHS",
        amountMinorUnits: 10_000n,
        status: "POSTED",
        providerPayload: { channel: "USSD" },
        occurredAt: new Date(event.occurredAt),
      })
      .returning()
      .then(([row]) => row!);
    const receipts = createReceiptService({
      database,
      accountLinkBaseUrl: "https://customer.somo.example/account",
      ussdInstructions: "Dial *123# and select Somoco Payments.",
    });
    const [first, second] = await Promise.all([
      receipts.issue({ payment }),
      receipts.issue({ payment }),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.securePath).toContain(`/receipts/${first.id}`);
    expect(second.securePath).toContain(`/receipts/${first.id}`);
    expect(
      (
        await getInternalDatabase(database).execute<{ count: number }>(
          sql`select count(*)::int as count from outbox_message where topic = 'payments.receipt_sms_requested' and aggregate_id = ${first.id}`,
        )
      ).rows[0]?.count,
    ).toBe(1);
  });

  it("attributes settlement comparison audit to its authenticated finance actor", async () => {
    const staffUserId = await insertStaff(database, "FINANCE_OFFICER");
    const actor: StaffPrincipal = {
      kind: "staff",
      staffUserId,
      roles: ["FINANCE_OFFICER"],
      sessionId: randomUUID(),
    };
    const reconciliation = createReconciliationService({ database });
    const result = await reconciliation.compareSettlement({
      settlementReference: "settle-actor",
      provider: "SOMOCO_PAYMENTS",
      providerTotalMinorUnits: 0n,
      actor,
    });
    const audit = await getInternalDatabase(database).execute<{
      actor_staff_user_id: string | null;
    }>(sql`
      select actor_staff_user_id
        from audit_event
       where aggregate_type = 'payment_settlement_batch'
         and aggregate_id = ${result.id}
    `);
    expect(audit.rows[0]?.actor_staff_user_id).toBe(staffUserId);
    await expect(
      reconciliation.compareSettlement({
        settlementReference: "settle-unauthorized",
        provider: "SOMOCO_PAYMENTS",
        providerTotalMinorUnits: 0n,
        actor: {
          ...actor,
          roles: ["CUSTOMER_SUPPORT"],
        },
      }),
    ).rejects.toThrow("FORBIDDEN");
    await expect(
      reconciliation.compareSettlement({
        settlementReference: "settle-md",
        provider: "SOMOCO_PAYMENTS",
        providerTotalMinorUnits: 0n,
        actor: {
          ...actor,
          roles: ["MD"],
        },
      }),
    ).rejects.toThrow("FORBIDDEN");
    const auditor = {
      ...actor,
      roles: ["COMPLIANCE_AUDITOR"] as StaffRole[],
    };
    await expect(
      reconciliation.compareSettlement({
        settlementReference: "settle-auditor",
        provider: "SOMOCO_PAYMENTS",
        providerTotalMinorUnits: 0n,
        actor: auditor,
      }),
    ).rejects.toThrow("FORBIDDEN");
    const caseId = randomUUID();
    await getInternalDatabase(database).insert(reconciliationCase).values({
      id: caseId,
      reason: "TEST_AUDITOR_RESOLVE",
    });
    await expect(
      reconciliation.resolveCase({
        caseId,
        actor: auditor,
        resolution: { note: "Auditor must remain read-only" },
      }),
    ).rejects.toThrow("FORBIDDEN");
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
  const evidence = approval.evidence;
  await getInternalDatabase(database).execute(sql`
    insert into payment_allocation_policy
      (version, policy_hash, worked_example_hash, worked_example,
       behavior_digest, evidence_hash, evidence_artifact,
       finance_approved_by, compliance_approved_by,
       finance_signature, compliance_signature,
       finance_approved_at, compliance_approved_at,
       approved_at, status)
    values
      (${approval.version}, ${evidence.evidenceHash}, ${evidence.evidenceHash}, ${JSON.stringify(
        evidence.artifact,
      )}::jsonb, ${approval.behaviorDigest}, ${evidence.evidenceHash}, ${JSON.stringify(
        evidence.artifact,
      )}::jsonb, ${evidence.financeApprovedBy}, ${evidence.complianceApprovedBy}, ${evidence.financeSignature}, ${evidence.complianceSignature}, ${evidence.financeApprovedAt}, ${evidence.complianceApprovedAt}, ${evidence.financeApprovedAt}, 'APPROVED')
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
  role: StaffRole,
): Promise<string> {
  const db = getInternalDatabase(database);
  const id = randomUUID();
  await db
    .insert(staffUser)
    .values({ id, email: `${id}@example.test`, passwordHash: "test-hash" });
  await db.insert(staffRoleAssignment).values({ staffUserId: id, role });
  return id;
}

function staffPrincipal(staffUserId: string, role: StaffRole): StaffPrincipal {
  return {
    kind: "staff",
    staffUserId,
    roles: [role],
    sessionId: randomUUID(),
  };
}

async function settlePaymentFixture(
  database: Database,
  contractId: string,
): Promise<Record<string, unknown>> {
  const financeId = await insertStaff(database, "CFO");
  const businessId = await insertStaff(database, "MD");
  const documentId = randomUUID();
  const internal = getInternalDatabase(database);
  await internal.execute(sql`
    insert into privacy.document
      (id, person_id, document_type, object_key, declared_mime_type,
       declared_size_bytes, upload_ticket_hash, upload_expires_at,
       accepted_object_key, accepted_object_version_id, accepted_object_etag,
       sha256, status, malware_scanned)
    select ${documentId}, a.applicant_person_id, 'TRANSFER_EVIDENCE',
           ${`pending/${documentId}`}, 'application/pdf', 128,
           ${"a".repeat(64)}, now() + interval '5 minutes',
           ${`accepted/${documentId}`}, 'v1', 'etag', ${"b".repeat(64)},
           'ACCEPTED', true
      from contract c
      join application a on a.id = c.application_id
     where c.id = ${contractId}
  `);
  const settlement = createSettlementService({ database });
  await settlement.recordEvidence({
    contractId,
    evidenceDocumentId: documentId,
    actor: staffPrincipal(businessId, "MD"),
  });
  await settlement.approveFinance({
    contractId,
    reason: "Verified replacement payment reconciliation",
    idempotencyKey: `finance-${contractId}`,
    actor: staffPrincipal(financeId, "CFO"),
  });
  await settlement.approveBusiness({
    contractId,
    reason: "Verified ownership transfer prerequisites",
    idempotencyKey: `business-${contractId}`,
    actor: staffPrincipal(businessId, "MD"),
  });
  return settlement.settle({
    contractId,
    actor: staffPrincipal(financeId, "CFO"),
  });
}

async function insertHttpStaff(database: Database, role: StaffRole) {
  return createStaffUser(database, {
    email: `${role}-${randomUUID()}@example.test`,
    passwordHash: await argon2.hash("correct horse battery staple", {
      type: argon2.argon2id,
      memoryCost: config.argon2MemoryCostKiB,
      timeCost: config.argon2TimeCost,
      parallelism: config.argon2Parallelism,
    }),
    roles: [role],
  });
}

async function login(
  app: Awaited<ReturnType<typeof buildApp>>,
  email: string,
): Promise<{ cookie: string; csrf: string }> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/staff/sessions",
    payload: {
      email,
      password: "correct horse battery staple",
      mfaAssertion: "valid",
    },
  });
  const setCookies = (
    Array.isArray(response.headers["set-cookie"])
      ? response.headers["set-cookie"]
      : [response.headers["set-cookie"]]
  ).filter((value): value is string => typeof value === "string");
  return {
    cookie: setCookies.map((value) => value.split(";", 1)[0]).join("; "),
    csrf: response.json<{ csrfToken: string }>().csrfToken,
  };
}

async function buildPaymentHttpApp(database: Database) {
  const sms: SmsPort = {
    send: async () => ({
      providerReference: randomUUID(),
      acceptedAt: new Date().toISOString(),
    }),
  };
  return buildApp({
    config,
    database,
    logger: false,
    mfaVerifier: {
      kind: "test",
      async verify({ assertion }) {
        return assertion === "valid";
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

  it("keeps auditor read-only for settlement compare and reconciliation resolve", async () => {
    const auditor = await insertHttpStaff(database, "COMPLIANCE_AUDITOR");
    const finance = await insertHttpStaff(database, "FINANCE_OFFICER");
    const caseId = randomUUID();
    await getInternalDatabase(database).insert(reconciliationCase).values({
      id: caseId,
      reason: "HTTP_AUDITOR_RESOLVE",
    });
    const app = await buildPaymentHttpApp(database);
    try {
      const auditorLogin = await login(app, auditor.email);
      const financeLogin = await login(app, finance.email);
      const compareDenied = await app.inject({
        method: "POST",
        url: "/v1/staff/payments/settlements/compare",
        headers: {
          cookie: auditorLogin.cookie,
          "x-csrf-token": auditorLogin.csrf,
        },
        payload: {
          settlementReference: "http-auditor-compare",
          providerTotalMinorUnits: "0",
        },
      });
      expect(compareDenied.statusCode).toBe(403);
      const resolveDenied = await app.inject({
        method: "POST",
        url: `/v1/staff/payments/reconciliation/${caseId}/resolve`,
        headers: {
          cookie: auditorLogin.cookie,
          "x-csrf-token": auditorLogin.csrf,
        },
        payload: { resolution: { note: "auditor" } },
      });
      expect(resolveDenied.statusCode).toBe(403);
      const compareAllowed = await app.inject({
        method: "POST",
        url: "/v1/staff/payments/settlements/compare",
        headers: {
          cookie: financeLogin.cookie,
          "x-csrf-token": financeLogin.csrf,
        },
        payload: {
          settlementReference: "http-finance-compare",
          providerTotalMinorUnits: "0",
        },
      });
      expect(compareAllowed.statusCode).toBe(200);
      const resolveAllowed = await app.inject({
        method: "POST",
        url: `/v1/staff/payments/reconciliation/${caseId}/resolve`,
        headers: {
          cookie: financeLogin.cookie,
          "x-csrf-token": financeLogin.csrf,
        },
        payload: { resolution: { note: "finance" } },
      });
      expect(resolveAllowed.statusCode).toBe(204);
    } finally {
      await app.close();
    }
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
