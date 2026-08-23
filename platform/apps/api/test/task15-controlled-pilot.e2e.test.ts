import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CanonicalPaymentEvent } from "../../../packages/integrations/src/index.js";
import { queryTestSql } from "../../../packages/testkit/src/index.js";
import {
  startRealPilot,
  type PilotRuntime,
} from "../../../test/e2e/support/real-pilot.js";
import {
  approveAllStages,
  body,
  call,
  completeOnboarding,
  createAndAcceptOffer,
  postPayment,
  type ApiRequest,
  type ApiResponse,
} from "../../../test/e2e/support/pilot-client.js";

const databaseUrl = "postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test";
process.env.TEST_DATABASE_URL = databaseUrl;

let runtime: PilotRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("Task 15 controlled pilot against the real app composition", () => {
  it("completes customer onboarding, durable approvals, and an accepted offer", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    const offer = await createAndAcceptOffer(request, flow);

    expect(offer).toMatchObject({
      status: "ACCEPTED",
      applicationId: flow.applicationId,
    });
    const application = await call(
      request,
      runtime.baseUrl,
      "get",
      `/v1/staff/applications/${flow.applicationId}`,
      {
        headers: runtime.staff.get("MD")!.headers,
      },
    );
    expect(application.status()).toBe(200);
    await expect(body(application)).resolves.toMatchObject({
      status: "APPROVED",
    });

    const approvalEvidence = await queryTestSql<{
      approval_count: string;
      stage_count: string;
      actor_count: string;
      idempotency_count: string;
    }>(
      databaseUrl,
      `select count(*) filter (where action = 'APPLICATION_APPROVAL_DECIDED')::text as approval_count,
              count(distinct data->>'stage') filter (where action = 'APPLICATION_APPROVAL_DECIDED')::text as stage_count,
              count(distinct actor_staff_user_id) filter (where action = 'APPLICATION_APPROVAL_DECIDED')::text as actor_count,
              count(*) filter (where action = 'APPLICATION_APPROVAL_DECIDED' and data ? 'idempotencyKey')::text as idempotency_count
         from audit_event
        where aggregate_type = 'application' and aggregate_id = $1`,
      [flow.applicationId],
    );
    expect(approvalEvidence).toEqual({
      approval_count: "6",
      stage_count: "6",
      actor_count: "5",
      idempotency_count: "6",
    });

    const guarantorEvidence = await queryTestSql<{
      consent_count: string;
      identity_count: string;
      document_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from privacy.consent_evidence where person_id = $1 and purpose = 'NIA_IDENTITY_VERIFICATION')::text as consent_count,
          (select count(*) from privacy.identity_check where person_id = $1 and status = 'VERIFIED')::text as identity_count,
          (select count(*) from privacy.document where person_id = $1 and status = 'ACCEPTED')::text as document_count`,
      [runtime.applicationFixtures.guarantorId],
    );
    expect(guarantorEvidence).toEqual({
      consent_count: "1",
      identity_count: "1",
      document_count: "1",
    });
  }, 60_000);

  it("rejects a wrong-role approval and licence-disallowed tenure at public boundaries", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);

    const wrongRole = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/approve`,
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: {
          expectedVersion: await currentVersion(
            request,
            runtime,
            flow.applicationId,
          ),
          stage: "VERIFICATION",
          note: "A support role must not approve underwriting.",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(wrongRole.status()).toBe(403);
    await expect(body(wrongRole)).resolves.toMatchObject({ code: "FORBIDDEN" });

    await approveAllStages(request, flow);
    const disallowedTenure = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/applications/${flow.applicationId}/offers`,
      {
        headers: runtime.customer.applicant.headers,
        body: {
          depositMinor: "10000",
          frequency: "MONTHLY",
          tenureMonths: 12,
          firstDueDate: "2026-08-15",
          expiresAt: "2026-08-31T00:00:00.000Z",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(disallowedTenure.status()).toBe(400);
    await expect(body(disallowedTenure)).resolves.toMatchObject({
      code: "TENURE_NOT_ALLOWED",
    });
  }, 60_000);

  it("replays an unmatched simulator payment without a second transaction or reconciliation case", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);

    const event: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-unmatched-payment-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId: "controlled-pilot-provider-transaction-001",
      payerPhoneE164: "+233241000001",
      customerReference: "CONTRACT-REFERENCE-NOT-FOUND",
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-01T12:10:00.000Z",
    };
    const first = await postPayment(request, flow, event);
    expect(first.status()).toBe(202);
    await expect(body(first)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      outcome: "QUARANTINED",
      reason: "UNMATCHED_CUSTOMER_REFERENCE",
    });
    const replay = await postPayment(request, flow, {
      ...event,
      eventId: "controlled-pilot-unmatched-payment-002",
    });
    expect(replay.status()).toBe(202);
    await expect(body(replay)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      outcome: "QUARANTINED",
    });

    const persisted = await queryTestSql<{
      payment_count: string;
      case_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction where provider_transaction_id = $1)::text as payment_count,
          (select count(*) from reconciliation_case rc join payment_transaction p on p.id = rc.payment_transaction_id where p.provider_transaction_id = $1)::text as case_count`,
      [event.providerTransactionId],
    );
    expect(persisted).toEqual({ payment_count: "1", case_count: "1" });
  }, 60_000);

  it("enforces inventory-officer ownership, registration, insurance, and deposit guards", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);

    const vehicle = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/staff/assets",
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          vehicleModelId: runtime.applicationFixtures.vehicleModelId,
          vin: "CONTROLLED-PILOT-VIN-001",
          chassisNumber: "CONTROLLED-PILOT-CHASSIS-001",
          engineMotorIdentifier: "CONTROLLED-PILOT-ENGINE-001",
          condition: { state: "NEW" },
          accessories: ["helmet"],
          trackerIdentifier: "CONTROLLED-PILOT-TRACKER-001",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(vehicle.status()).toBe(201);
    const vehicleBody = await body(vehicle);
    const vehicleId = String(vehicleBody.id);
    let vehicleVersion = Number(vehicleBody.version);

    const registration = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/assets/${vehicleId}/registration`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          registrationNumber: "GT-001-26",
          validFrom: "2026-08-01",
          validTo: "2027-08-01",
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(registration.status()).toBe(200);
    vehicleVersion = Number((await body(registration)).version);

    const insurance = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/assets/${vehicleId}/insurance`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          policyNumber: "CONTROLLED-PILOT-POLICY-001",
          provider: "Controlled Pilot Insurer",
          validFrom: "2026-08-01",
          validTo: "2027-08-01",
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(insurance.status()).toBe(200);
    vehicleVersion = Number((await body(insurance)).version);

    const wrongRole = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/asset-assignment`,
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: {
          vehicleUnitId: vehicleId,
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(wrongRole.status()).toBe(403);
    await expect(body(wrongRole)).resolves.toMatchObject({ code: "FORBIDDEN" });

    const missingDeposit = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/asset-assignment`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          vehicleUnitId: vehicleId,
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(missingDeposit.status()).toBe(409);
    await expect(body(missingDeposit)).resolves.toMatchObject({
      code: "DEPOSIT_RECONCILIATION_REQUIRED",
    });
  }, 60_000);

  it("fails closed for provider verification and recovery-role boundaries", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    const before = await queryTestSql<{ payments: string; inbox: string }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction)::text as payments,
          (select count(*) from inbox_message where provider = 'SOMOCO_PAYMENTS')::text as inbox`,
    );
    const event: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-invalid-provider-event-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId:
        "controlled-pilot-invalid-provider-transaction-001",
      payerPhoneE164: "+233241000001",
      customerReference: flow.applicationId,
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-01T12:15:00.000Z",
    };
    const invalid = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/integrations/payments/somoco",
      {
        headers: {
          "content-type": "application/json",
          "x-payment-signature": "not-a-registered-simulator-signature",
          "x-payment-timestamp": event.occurredAt,
        },
        body: event as unknown as Record<string, unknown>,
      },
    );
    expect(invalid.status()).toBe(401);
    await expect(body(invalid)).resolves.toMatchObject({
      code: "PAYMENT_VERIFICATION_FAILED",
    });

    const recovery = await call(
      request,
      runtime.baseUrl,
      "get",
      "/v1/staff/collections/arrears",
      {
        headers: runtime.staff.get("RECOVERY_OFFICER")!.headers,
      },
    );
    expect(recovery.status()).toBe(200);
    await expect(recovery.json()).resolves.toEqual([]);
    const supportRecovery = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/staff/collections/cases",
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: {
          contractId: randomUUID(),
          purpose: "CONTROLLED_PILOT_ROLE_CHECK",
          reason: "A support role must not open a recovery case.",
        },
      },
    );
    expect(supportRecovery.status()).toBe(403);
    await expect(body(supportRecovery)).resolves.toMatchObject({
      code: "FORBIDDEN",
    });

    const after = await queryTestSql<{ payments: string; inbox: string }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction)::text as payments,
          (select count(*) from inbox_message where provider = 'SOMOCO_PAYMENTS')::text as inbox`,
    );
    expect(after).toEqual(before);
  }, 60_000);
});

async function currentVersion(
  request: ApiRequest,
  runtime: PilotRuntime,
  applicationId: string,
): Promise<number> {
  const response = await call(
    request,
    runtime.baseUrl,
    "get",
    `/v1/staff/applications/${applicationId}`,
    {
      headers: runtime.staff.get("VERIFICATION_OFFICER")!.headers,
    },
  );
  expect(response.status()).toBe(200);
  return Number((await body(response)).version);
}

function injectRequest(app: FastifyInstance): ApiRequest {
  return {
    get: (url, options) => inject(app, "GET", url, options),
    post: (url, options) => inject(app, "POST", url, options),
    patch: (url, options) => inject(app, "PATCH", url, options),
  };
}

async function inject(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: Record<string, unknown> = {},
): Promise<ApiResponse> {
  const headers = (options.headers ?? {}) as Record<string, string>;
  const injectOptions: {
    method: "GET" | "POST" | "PATCH";
    url: string;
    headers: Record<string, string>;
    payload?: string;
  } = {
    method,
    url: new URL(url).pathname,
    headers,
  };
  if (options.data !== undefined)
    injectOptions.payload = JSON.stringify(options.data);
  const response = await app.inject(injectOptions);
  return {
    status: () => response.statusCode,
    json: async () => response.json(),
    text: async () => response.body,
  };
}
