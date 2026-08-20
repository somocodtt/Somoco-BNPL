import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type Database,
  type DatabaseStaffRole,
} from "@somo/db";
import {
  FinanceApprovalGate,
  hashWorkedExample,
  type WorkedExampleFixture,
} from "@somo/domain/src/index.js";
import { executeTestSql, queryTestSql, resetTestDatabase } from "../../../packages/testkit/src/index.js";
import type { CustomerPrincipal, StaffPrincipal, StaffRole } from "../src/modules/access/policy.js";
import { createExceptionService, type ExceptionService } from "../src/modules/products/exception-service.js";
import { createOfferService, type OfferService } from "../src/modules/products/offer-service.js";
import { createProductService, type ProductService } from "../src/modules/products/service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error("TEST_DATABASE_URL is required for financing API integration tests");
}

let database: Database;
let closeDatabase: () => Promise<void>;
let products: ProductService;
let exceptions: ExceptionService;
let offers: OfferService;
let fixture: WorkedExampleFixture;

beforeAll(() => {
  const connection = createDatabase(databaseUrl!);
  database = connection.db;
  closeDatabase = connection.close;
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl!);
  await migrateDatabase(database);
  fixture = testFixture();
  const gate = new FinanceApprovalGate([fixture], false);
  products = createProductService({ database, fixtureGate: gate });
  exceptions = createExceptionService({ database });
  offers = createOfferService({ database, products, exceptions, fixtureGate: gate });
});

afterAll(async () => {
  await closeDatabase();
});

describe("controlled financing API against PostgreSQL", () => {
  it("publishes effective rules only in a non-overlapping window and locks them", async () => {
    const graph = await seedGraph();
    const maker = await seedStaff("maker", "PRODUCT_ADMIN");
    const checker = await seedStaff("checker", "PRODUCT_ADMIN");
    const rule = await createRule(graph, maker, { requestedVersion: 1, publish: false });
    const published = await products.publishRuleVersion({
      ruleId: rule.id,
      actor: checker.actor,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      effectiveUntil: new Date(Date.now() + 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });

    expect(published.approved).toBe(true);
    expect((await products.getEffectiveRule(graph.productId)).id).toBe(rule.id);
    await expect(
      executeTestSql(
        databaseUrl!,
        "update financing_rule_version set permitted_fees = '{\"tampered\":true}'::jsonb where id = $1",
        [rule.id],
      ),
    ).rejects.toMatchObject({ code: "P0001" });
    await expect(
      executeTestSql(databaseUrl!, "delete from financing_rule_version where id = $1", [rule.id]),
    ).rejects.toMatchObject({ code: "P0001" });
  });

  it("enforces maker-checker separation and remains fail-closed without a fixture", async () => {
    const graph = await seedGraph();
    const maker = await seedStaff("maker-only", "PRODUCT_ADMIN");
    const draft = await createRule(graph, maker, { requestedVersion: 1, publish: false });

    await expect(
      products.publishRuleVersion({
        ruleId: draft.id,
        actor: maker.actor,
        effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("RULE_PUBLISH_REJECTED");

    const failClosedProducts = createProductService({ database });
    await expect(
      failClosedProducts.publishRuleVersion({
        ruleId: draft.id,
        actor: (await seedStaff("unrelated-checker", "PRODUCT_ADMIN")).actor,
        effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("FINANCE_FIXTURE_REQUIRED");
  });

  it("keeps an unlicensed rule out of the effective set", async () => {
    const graph = await seedGraph();
    const maker = await seedStaff("licence-maker", "PRODUCT_ADMIN");
    const checker = await seedStaff("licence-checker", "PRODUCT_ADMIN");
    const draft = await createRule(graph, maker, {
      requestedVersion: 1,
      publish: false,
      licencePermitted: false,
    });
    await products.publishRuleVersion({
      ruleId: draft.id,
      actor: checker.actor,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    await expect(products.getEffectiveRule(graph.productId)).rejects.toMatchObject({
      code: "NO_EFFECTIVE_FINANCING_RULE",
    });
  });

  it("requires the minimum deposit unless a separately approved exception exists", async () => {
    const graph = await seedGraph();
    const maker = await seedStaff("exception-maker", "PRODUCT_ADMIN");
    const checker = await seedStaff("exception-checker", "PRODUCT_ADMIN");
    const draft = await createRule(graph, maker, { requestedVersion: 1, publish: false });
    await products.publishRuleVersion({
      ruleId: draft.id,
      actor: checker.actor,
      effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
      effectiveUntil: new Date(Date.now() + 86_400_000).toISOString(),
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });

    const baseOffer = {
      applicationId: graph.applicationId,
      depositMinor: "10000",
      frequency: "MONTHLY" as const,
      tenureMonths: 6 as const,
      firstDueDate: "2026-09-01",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      actor: graph.customer,
      requestId: randomUUID(),
    };
    await expect(offers.create({ ...baseOffer, idempotencyKey: randomUUID() })).rejects.toMatchObject({
      code: "MINIMUM_DEPOSIT_REQUIRED",
    });

    const exception = await exceptions.request({
      applicationId: graph.applicationId,
      proposedValue: { minimumDepositMinor: "10000" },
      policyValue: { minimumDepositMinor: "30000" },
      reason: "Documented pilot hardship review.",
      requiredApproverRole: "PRODUCT_ADMIN",
      idempotencyKey: randomUUID(),
      actor: maker.actor,
      requestId: randomUUID(),
    });
    await expect(
      exceptions.decide({
        exceptionId: exception.id,
        expectedVersion: exception.version,
        decision: "APPROVE",
        reason: "Independent review completed.",
        idempotencyKey: randomUUID(),
        actor: maker.actor,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "EXCEPTION_REQUESTER_CANNOT_APPROVE" });
    const approved = await exceptions.decide({
      exceptionId: exception.id,
      expectedVersion: exception.version,
      decision: "APPROVE",
      reason: "Independent review completed.",
      idempotencyKey: randomUUID(),
      actor: checker.actor,
      requestId: randomUUID(),
    });
    expect(approved.status).toBe("APPROVED");
    await expect(offers.create({ ...baseOffer, idempotencyKey: randomUUID() })).resolves.toMatchObject({
      status: "PENDING",
    });
    await expect(
      exceptions.decide({
        exceptionId: exception.id,
        expectedVersion: exception.version,
        decision: "APPROVE",
        reason: "stale replay",
        idempotencyKey: randomUUID(),
        actor: checker.actor,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "EXCEPTION_STALE_OR_EXPIRED" });
  });

  it("locks accepted offer terms, rejects expiry, and records idempotent work evidence", async () => {
    const graph = await seedGraph();
    const maker = await seedStaff("offer-maker", "PRODUCT_ADMIN");
    const checker = await seedStaff("offer-checker", "PRODUCT_ADMIN");
    await createRule(graph, maker, { requestedVersion: 1 });
    const idempotencyKey = randomUUID();
    const first = await offers.create({
      applicationId: graph.applicationId,
      depositMinor: "30000",
      frequency: "MONTHLY",
      tenureMonths: 6,
      firstDueDate: "2026-09-01",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      idempotencyKey,
      actor: graph.customer,
      requestId: randomUUID(),
    });
    const replay = await offers.create({
      applicationId: graph.applicationId,
      depositMinor: "30000",
      frequency: "MONTHLY",
      tenureMonths: 6,
      firstDueDate: "2026-09-01",
      expiresAt: first.expiresAt!.toISOString(),
      idempotencyKey,
      actor: graph.customer,
      requestId: randomUUID(),
    });
    expect(replay.id).toBe(first.id);

    const accepted = await offers.accept({
      offerId: first.id,
      expectedVersion: 1,
      consentAt: new Date().toISOString(),
      idempotencyKey: randomUUID(),
      actor: graph.customer,
      requestId: randomUUID(),
    });
    expect(accepted.status).toBe("ACCEPTED");
    await expect(
      executeTestSql(databaseUrl!, "update offer set expires_at = expires_at where id = $1", [first.id]),
    ).rejects.toMatchObject({ code: "P0001" });

    const counts = await queryTestSql<{ audit: string; outbox: string }>(
      databaseUrl!,
      `select
         (select count(*)::text from audit_event where aggregate_type = 'offer' and aggregate_id = $1) as audit,
         (select count(*)::text from outbox_message where aggregate_type = 'offer' and aggregate_id = $1) as outbox`,
      [first.id],
    );
    expect(Number(counts.audit)).toBeGreaterThanOrEqual(2);
    expect(Number(counts.outbox)).toBeGreaterThanOrEqual(2);

    const expiringGraph = await seedGraph();
    await createRule(expiringGraph, maker, { requestedVersion: 2 });
    const expiring = await offers.create({
      applicationId: expiringGraph.applicationId,
      depositMinor: "30000",
      frequency: "MONTHLY",
      tenureMonths: 6,
      firstDueDate: "2026-09-01",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      idempotencyKey: randomUUID(),
      actor: expiringGraph.customer,
      requestId: randomUUID(),
    });
    await executeTestSql(databaseUrl!, "update offer set expires_at = now() - interval '1 minute' where id = $1", [expiring.id]);
    await expect(
      offers.accept({
        offerId: expiring.id,
        expectedVersion: 1,
        consentAt: new Date().toISOString(),
        idempotencyKey: randomUUID(),
        actor: expiringGraph.customer,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "OFFER_STALE_OR_EXPIRED" });

    void checker;
  });
});

async function seedGraph(): Promise<{
  applicantId: string;
  applicationId: string;
  productId: string;
  vehicleModelId: string;
  customer: CustomerPrincipal;
}> {
  const applicantId = randomUUID();
  const vehicleModelId = randomUUID();
  const productId = randomUUID();
  const applicationId = randomUUID();
  const phone = `+2332${Math.floor(Math.random() * 100000000).toString().padStart(8, "0")}`;
  const modelName = `Pilot-${productId.slice(0, 8)}`;
  const productCode = `PILOT-${productId.slice(0, 8)}`;
  await executeTestSql(
    databaseUrl!,
    "insert into privacy.person (id, phone_e164) values ($1, $2)",
    [applicantId, phone],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into vehicle_model (id, manufacturer, model_name, model_year, active) values ($1, 'Synthetic Motors', $2, 2026, true)",
    [vehicleModelId, modelName],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into product (id, code, name, vehicle_model_id, status) values ($1, $2, 'Controlled pilot product', $3, 'ACTIVE')",
    [productId, productCode, vehicleModelId],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into application (id, applicant_person_id, product_id, status, version, submitted_at) values ($1, $2, $3, 'APPROVED', 7, now())",
    [applicationId, applicantId, productId],
  );
  return {
    applicantId,
    applicationId,
    productId,
    vehicleModelId,
    customer: customerPrincipal(applicantId),
  };
}

async function seedStaff(label: string, role: string): Promise<{ id: string; actor: StaffPrincipal }> {
  const user = await createStaffUser(database, {
    email: `${label}-${randomUUID()}@example.test`,
    passwordHash: "test-password-hash",
    roles: [role as DatabaseStaffRole],
  });
  return { id: user.id, actor: staffPrincipal(user.id, role) };
}

async function createRule(
  graph: { productId: string },
  maker: { actor: StaffPrincipal },
  input: {
    requestedVersion: number;
    publish?: boolean;
    licencePermitted?: boolean;
  },
): Promise<{ id: string; versionNumber: number }> {
  const draft = await products.createRuleVersion({
    productId: graph.productId,
    versionNumber: input.requestedVersion,
    sellingPriceMinor: "100000",
    minimumDepositMinor: "30000",
    method: "FLAT_MARKUP",
    rateBasisPoints: 0,
    allowedTenuresMonths: [6],
    repaymentFrequencies: ["MONTHLY"],
    fixtureHashes: [fixture.canonicalHash],
    licencePermitted: input.licencePermitted ?? true,
    actor: maker.actor,
    requestId: randomUUID(),
  });
  if (input.publish === false) return draft;
  const checker = await seedStaff(`checker-${input.requestedVersion}`, "PRODUCT_ADMIN");
  return products.publishRuleVersion({
    ruleId: draft.id,
    actor: checker.actor,
    effectiveFrom: new Date(Date.now() - 60_000).toISOString(),
    effectiveUntil: new Date(Date.now() + 86_400_000).toISOString(),
    idempotencyKey: randomUUID(),
    requestId: randomUUID(),
  });
}

function testFixture(): WorkedExampleFixture {
  const unsigned = {
    schemaVersion: 1 as const,
    fixtureId: "task-9-test-only-monthly-6",
    method: "FLAT_MARKUP" as const,
    frequency: "MONTHLY" as const,
    tenureMonths: 6 as const,
    workedExample: { testOnly: true },
    financeApproved: true,
    complianceApproved: true,
    licencePermitted: true,
    synthetic: true,
  };
  return { ...unsigned, canonicalHash: hashWorkedExample(unsigned) };
}

function staffPrincipal(staffUserId: string, role: string): StaffPrincipal {
  return { kind: "staff", staffUserId, roles: [role as StaffRole], sessionId: randomUUID() };
}

function customerPrincipal(personId: string): CustomerPrincipal {
  return { kind: "customer", customerAccountId: randomUUID(), personId, sessionId: randomUUID() };
}
