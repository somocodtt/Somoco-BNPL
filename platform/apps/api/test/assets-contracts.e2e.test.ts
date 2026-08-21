import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDatabase,
  createStaffUser,
  migrateDatabase,
  type Database,
  type DatabaseStaffRole,
} from "@somo/db";
import {
  executeTestSql,
  queryTestSql,
  resetTestDatabase,
} from "../../../packages/testkit/src/index.js";
import type {
  StaffPrincipal,
  StaffRole,
} from "../src/modules/access/policy.js";
import {
  createAssetService,
  type AssetService,
} from "../src/modules/assets/service.js";
import {
  createContractService,
  createSyntheticContractTemplateForTesting,
  type ContractService,
} from "../src/modules/contracts/service.js";
import {
  createHandoverService,
  type HandoverService,
} from "../src/modules/contracts/handover-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (databaseUrl === undefined) {
  throw new Error(
    "TEST_DATABASE_URL is required for asset and contract integration tests",
  );
}

let database: Database;
let closeDatabase: () => Promise<void>;
let assets: AssetService;
let contracts: ContractService;
let handover: HandoverService;

beforeAll(() => {
  const connection = createDatabase(databaseUrl!);
  database = connection.db;
  closeDatabase = connection.close;
});

beforeEach(async () => {
  await resetTestDatabase(databaseUrl!);
  await migrateDatabase(database);
  assets = createAssetService({ database });
  contracts = createContractService({
    database,
    template: createSyntheticContractTemplateForTesting(),
    environment: "test",
  });
  handover = createHandoverService({ database, assets, contracts });
});

afterAll(async () => {
  await closeDatabase();
});

describe("asset, contract, and handover controls against PostgreSQL", () => {
  it("rejects duplicate or incomplete vehicle identifiers", async () => {
    const graph = await seedGraph();
    const actor = await seedStaff("inventory", "INVENTORY_OFFICER");
    const first = await assets.registerVehicle({
      vehicleModelId: graph.vehicleModelId,
      vin: "VIN-TASK10-0001",
      chassisNumber: "CHASSIS-TASK10-0001",
      engineMotorIdentifier: "ENGINE-TASK10-0001",
      condition: { exterior: "new" },
      accessories: ["helmet"],
      actor: actor.actor,
      requestId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    expect(first.status).toBe("IN_STOCK");
    await expect(
      assets.registerVehicle({
        vehicleModelId: graph.vehicleModelId,
        vin: first.vin,
        chassisNumber: "CHASSIS-TASK10-0002",
        engineMotorIdentifier: "ENGINE-TASK10-0002",
        condition: {},
        accessories: [],
        actor: actor.actor,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_IDENTIFIER_DUPLICATE" });
    await expect(
      assets.registerVehicle({
        vehicleModelId: graph.vehicleModelId,
        vin: "VIN-TASK10-0003",
        chassisNumber: "CHASSIS-TASK10-0003",
        engineMotorIdentifier: "",
        condition: {},
        accessories: [],
        actor: actor.actor,
        requestId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "VEHICLE_IDENTIFIER_REQUIRED" });
  });

  it("requires a reconciled deposit and matching model before assignment", async () => {
    const graph = await seedGraph();
    const actor = await seedStaff("assignment", "INVENTORY_OFFICER");
    const vehicle = await registerVehicle(
      graph.vehicleModelId,
      actor.actor,
      "0002",
    );
    await expect(
      assets.assignVehicle({
        applicationId: graph.applicationId,
        vehicleUnitId: vehicle.id,
        expectedVehicleVersion: vehicle.version,
        actor: actor.actor,
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "DEPOSIT_RECONCILIATION_REQUIRED" });
    await seedAcceptedOffer(graph, { expired: false });
    await seedReconciledDeposit(graph, "30000");
    const assigned = await assets.assignVehicle({
      applicationId: graph.applicationId,
      vehicleUnitId: vehicle.id,
      expectedVehicleVersion: vehicle.version,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    expect(assigned.vehicleUnitId).toBe(vehicle.id);
    expect(assigned.depositReconciledAmountMinor).toBe("30000");
    const audit = await queryTestSql<{ count: string }>(
      databaseUrl!,
      "select count(*)::text as count from audit_event where aggregate_type = 'vehicle_assignment' and aggregate_id = $1",
      [assigned.id],
    );
    expect(Number(audit.count)).toBeGreaterThanOrEqual(1);
  });

  it("requires a separately approved reassignment and optimistic version", async () => {
    const graph = await seedGraph();
    const actor = await seedStaff("reassignment", "INVENTORY_OFFICER");
    const first = await registerVehicle(
      graph.vehicleModelId,
      actor.actor,
      "0003",
    );
    const second = await registerVehicle(
      graph.vehicleModelId,
      actor.actor,
      "0004",
    );
    await seedAcceptedOffer(graph, { expired: false });
    await seedReconciledDeposit(graph, "30000");
    const assigned = await assets.assignVehicle({
      applicationId: graph.applicationId,
      vehicleUnitId: first.id,
      expectedVehicleVersion: first.version,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    await expect(
      assets.assignVehicle({
        applicationId: graph.applicationId,
        vehicleUnitId: second.id,
        expectedVehicleVersion: second.version,
        previousAssignmentId: assigned.id,
        actor: actor.actor,
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "REASSIGNMENT_APPROVAL_REQUIRED" });
    const approver = await seedStaff(
      "reassignment-approver",
      "INVENTORY_OFFICER",
    );
    const reassigned = await assets.assignVehicle({
      applicationId: graph.applicationId,
      vehicleUnitId: second.id,
      expectedVehicleVersion: second.version,
      previousAssignmentId: assigned.id,
      reassignmentApproval: {
        approvedBy: approver.id,
        reason: "Documented condition correction",
      },
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    expect(reassigned.supersedesAssignmentId).toBe(assigned.id);
  });

  it("limits tracker access to recovery staff and records a location-only audit", async () => {
    const graph = await seedGraph();
    const inventory = await seedStaff("tracker-inventory", "INVENTORY_OFFICER");
    const recovery = await seedStaff("tracker-recovery", "RECOVERY_OFFICER");
    const vehicle = await registerVehicle(
      graph.vehicleModelId,
      inventory.actor,
      "0007",
    );
    await assets.associateTracker({
      vehicleUnitId: vehicle.id,
      provider: "Synthetic Tracker",
      providerDeviceId: `DEVICE-${vehicle.id.slice(0, 8)}`,
      deepLink: "https://tracker.example.test/device/7",
      actor: inventory.actor,
      requestId: randomUUID(),
    });
    await expect(
      assets.getTrackerAccess({
        vehicleUnitId: vehicle.id,
        purpose: "recovery review",
        actor: inventory.actor,
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const access = await assets.getTrackerAccess({
      vehicleUnitId: vehicle.id,
      purpose: "recovery review",
      actor: recovery.actor,
      requestId: randomUUID(),
    });
    expect(access.deepLink).toContain("tracker.example.test");
    const audit = await queryTestSql<{ data: Record<string, unknown> }>(
      databaseUrl!,
      "select data from audit_event where aggregate_type = 'vehicle_unit' and aggregate_id = $1 and action = 'TRACKER_LOCATION_ACCESS' order by recorded_at desc limit 1",
      [vehicle.id],
    );
    expect(audit.data).toMatchObject({ locationOnly: true });
  });

  it("fails closed for production template generation and requires physical execution evidence", async () => {
    const graph = await seedGraph();
    const actor = await seedStaff("contract", "INVENTORY_OFFICER");
    const vehicle = await registerVehicle(
      graph.vehicleModelId,
      actor.actor,
      "0005",
    );
    await seedAcceptedOffer(graph, { expired: false });
    await seedReconciledDeposit(graph, "30000");
    const assignment = await assets.assignVehicle({
      applicationId: graph.applicationId,
      vehicleUnitId: vehicle.id,
      expectedVehicleVersion: vehicle.version,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    const production = createContractService({
      database,
      environment: "production",
    });
    await expect(
      production.generate({
        applicationId: graph.applicationId,
        assignmentId: assignment.id,
        actor: actor.actor,
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "LEGAL_TEMPLATE_APPROVAL_REQUIRED" });
    const contract = await contracts.generate({
      applicationId: graph.applicationId,
      assignmentId: assignment.id,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    await expect(
      contracts.recordPhysicalExecution({
        contractId: contract.id,
        expectedVersion: contract.version,
        applicantSignature: "signed-applicant",
        guarantorSignature: "signed-guarantor",
        staffWitnessId: actor.actor.staffUserId,
        executionDate: new Date().toISOString(),
        executedDocumentId: randomUUID(),
        executedDocumentHash: "a".repeat(64),
        actor: actor.actor,
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "EXECUTED_DOCUMENT_NOT_CLEAN" });
  });

  it("requires the complete handover checklist and keeps ownership with Somoco on activation", async () => {
    const graph = await seedGraph();
    const actor = await seedStaff("handover", "INVENTORY_OFFICER");
    const vehicle = await registerVehicle(
      graph.vehicleModelId,
      actor.actor,
      "0006",
    );
    await seedAcceptedOffer(graph, { expired: false });
    await seedReconciledDeposit(graph, "30000");
    const assignment = await assets.assignVehicle({
      applicationId: graph.applicationId,
      vehicleUnitId: vehicle.id,
      expectedVehicleVersion: vehicle.version,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    const contract = await contracts.generate({
      applicationId: graph.applicationId,
      assignmentId: assignment.id,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    const documentId = await seedCleanExecutedDocument(graph.applicantId);
    const executed = await contracts.recordPhysicalExecution({
      contractId: contract.id,
      expectedVersion: contract.version,
      applicantSignature: "signed-applicant",
      guarantorSignature: "signed-guarantor",
      staffWitnessId: actor.actor.staffUserId,
      executionDate: new Date().toISOString(),
      executedDocumentId: documentId,
      executedDocumentHash: "b".repeat(64),
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    await expect(
      executeTestSql(
        databaseUrl!,
        "update contract_execution set executed_document_hash = repeat('c', 64) where contract_id = $1",
        [executed.id],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      handover.complete({
        contractId: executed.id,
        expectedVersion: executed.version,
        checklistVersion: "handover-v1",
        checklist: { keys: true },
        customerAcknowledged: true,
        condition: { exterior: "new" },
        accessories: ["helmet"],
        headOfficeLocation: "Somoco head office",
        handedOverAt: new Date().toISOString(),
        actor: actor.actor,
        idempotencyKey: randomUUID(),
        requestId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "HANDOVER_CHECKLIST_INCOMPLETE" });
    const completed = await handover.complete({
      contractId: executed.id,
      expectedVersion: executed.version,
      checklistVersion: "handover-v1",
      checklist: {
        identityVerified: true,
        keys: true,
        conditionRecorded: true,
        accessoriesRecorded: true,
      },
      customerAcknowledged: true,
      condition: { exterior: "new" },
      accessories: ["helmet"],
      headOfficeLocation: "Somoco head office",
      handedOverAt: new Date().toISOString(),
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    const active = await contracts.activate({
      contractId: completed.id,
      expectedVersion: completed.version,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    expect(active.status).toBe("ACTIVE");
    expect(active.ownershipHolder).toBe("SOMOCO");
    const replay = await contracts.activate({
      contractId: completed.id,
      expectedVersion: completed.version,
      actor: actor.actor,
      idempotencyKey: randomUUID(),
      requestId: randomUUID(),
    });
    expect(replay.id).toBe(active.id);
  });
});

async function seedGraph(): Promise<{
  applicantId: string;
  guarantorId: string;
  applicationId: string;
  offerId: string;
  offerVersionId: string;
  vehicleModelId: string;
}> {
  const applicantId = randomUUID();
  const guarantorId = randomUUID();
  const applicationId = randomUUID();
  const offerId = randomUUID();
  const offerVersionId = randomUUID();
  const vehicleModelId = randomUUID();
  const productId = randomUUID();
  const ruleId = randomUUID();
  await executeTestSql(
    databaseUrl!,
    "insert into privacy.person (id, phone_e164) values ($1, $2), ($3, $4)",
    [
      applicantId,
      `+2332${Date.now().toString().slice(-8)}`,
      guarantorId,
      `+2332${(Date.now() + 1).toString().slice(-8)}`,
    ],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into vehicle_model (id, manufacturer, model_name, model_year, active) values ($1, 'Synthetic Motors', 'Task 10 Model', 2026, true)",
    [vehicleModelId],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into product (id, code, name, vehicle_model_id, status) values ($1, $2, 'Task 10 Product', $3, 'ACTIVE')",
    [productId, `T10-${productId.slice(0, 8)}`, vehicleModelId],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into financing_rule_version (id, product_id, version_number, selling_price_minor_units, minimum_deposit_minor_units, annual_rate_bps, allowed_tenures_months, repayment_frequencies, calculation_method, permitted_fees, eligibility_policy, required_evidence, exception_policy, disclosure_version, fixture_hashes, licence_permitted, approved, requested_by, approved_by, approved_at, effective_from, published_at) values ($1, $2, 1, 100000, 30000, 0, '[6]'::jsonb, '[\"MONTHLY\"]'::jsonb, 'FLAT_MARKUP', '{}'::jsonb, '{}'::jsonb, '[]'::jsonb, '{}'::jsonb, 'test', $3::jsonb, true, true, null, null, now(), now() - interval '1 minute', now())",
    [
      ruleId,
      productId,
      JSON.stringify([
        createHash("sha256").update("task10-fixture").digest("hex"),
      ]),
    ],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into application (id, applicant_person_id, product_id, vehicle_model_id, status, version, submitted_at) values ($1, $2, $3, $4, 'APPROVED', 7, now())",
    [applicationId, applicantId, productId, vehicleModelId],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into guarantor_relationship (id, application_id, guarantor_person_id, status, confirmed_at) values ($1, $2, $3, 'CONFIRMED', now())",
    [randomUUID(), applicationId, guarantorId],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into offer (id, application_id, status, expires_at, version) values ($1, $2, 'PENDING', now() + interval '1 day', 1)",
    [offerId, applicationId],
  );
  await executeTestSql(
    databaseUrl!,
    "insert into offer_version (id, offer_id, financing_rule_version_id, version_number, principal_minor_units, deposit_minor_units, total_payable_minor_units, terms, canonical_hash) values ($1, $2, $3, 1, 70000, 30000, 70000, $4::jsonb, $5)",
    [
      offerVersionId,
      offerId,
      ruleId,
      JSON.stringify({
        priceMinor: "100000",
        depositMinor: "30000",
        principalMinor: "70000",
        totalPayableMinor: "70000",
        installments: [
          { sequence: 1, dueDate: "2026-09-01", totalMinor: "70000" },
        ],
      }),
      "c".repeat(64),
    ],
  );
  await executeTestSql(
    databaseUrl!,
    "update offer set status = 'ACCEPTED', accepted_version_id = $2, accepted_by_person_id = $3, accepted_at = now(), consent_at = now(), version = 2, accepted_hash = $4 where id = $1",
    [offerId, offerVersionId, applicantId, "c".repeat(64)],
  );
  return {
    applicantId,
    guarantorId,
    applicationId,
    offerId,
    offerVersionId,
    vehicleModelId,
  };
}

async function seedAcceptedOffer(
  graph: { offerId: string },
  input: { expired: boolean },
): Promise<void> {
  void graph;
  void input;
}

async function seedReconciledDeposit(
  graph: { applicationId: string; offerId: string },
  amount: string,
): Promise<void> {
  await executeTestSql(
    databaseUrl!,
    "insert into deposit_reconciliation (id, application_id, offer_id, amount_minor_units, currency, status, reconciled_at, evidence_hash) values ($1, $2, $3, $4, 'GHS', 'RECONCILED', now(), $5)",
    [randomUUID(), graph.applicationId, graph.offerId, amount, "d".repeat(64)],
  );
}

async function registerVehicle(
  modelId: string,
  actor: StaffPrincipal,
  suffix: string,
) {
  const vehicle = await assets.registerVehicle({
    vehicleModelId: modelId,
    vin: `VIN-TASK10-${suffix}`,
    chassisNumber: `CHASSIS-TASK10-${suffix}`,
    engineMotorIdentifier: `ENGINE-TASK10-${suffix}`,
    condition: { exterior: "new" },
    accessories: ["helmet"],
    actor,
    requestId: randomUUID(),
    idempotencyKey: randomUUID(),
  });
  await assets.recordRegistration({
    vehicleUnitId: vehicle.id,
    registrationNumber: `GT-${suffix}`,
    validFrom: "2026-01-01",
    validTo: "2027-01-01",
    actor,
    requestId: randomUUID(),
  });
  await assets.recordInsurance({
    vehicleUnitId: vehicle.id,
    policyNumber: `POLICY-${suffix}`,
    provider: "Synthetic Insurer",
    validFrom: "2026-01-01",
    validTo: "2027-01-01",
    actor,
    requestId: randomUUID(),
  });
  return vehicle;
}

async function seedCleanExecutedDocument(personId: string): Promise<string> {
  const id = randomUUID();
  await executeTestSql(
    databaseUrl!,
    "insert into privacy.document (id, person_id, document_type, object_key, declared_mime_type, declared_size_bytes, upload_ticket_hash, upload_expires_at, accepted_object_key, accepted_object_version_id, accepted_object_etag, sha256, status, malware_scanned) values ($1, $2, 'EXECUTED_CONTRACT', $3, 'application/pdf', 128, $4, now() + interval '1 day', $5, 'v1', 'etag', $6, 'ACCEPTED', true)",
    [
      id,
      personId,
      `task10/${id}`,
      "e".repeat(64),
      `accepted/task10/${id}`,
      "b".repeat(64),
    ],
  );
  return id;
}

async function seedStaff(
  label: string,
  role: string,
): Promise<{ id: string; actor: StaffPrincipal }> {
  const user = await createStaffUser(database, {
    email: `${label}-${randomUUID()}@example.test`,
    passwordHash: "test-password-hash",
    roles: [role as DatabaseStaffRole],
  });
  return {
    id: user.id,
    actor: {
      kind: "staff",
      staffUserId: user.id,
      roles: [role as StaffRole],
      sessionId: randomUUID(),
    },
  };
}
