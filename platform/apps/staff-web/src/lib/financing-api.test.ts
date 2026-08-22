import { describe, expect, it, vi } from "vitest";
import { FetchStaffApi } from "./api.js";

describe("staff financing API adapter", () => {
  it("loads asset inventory and posts an idempotent assignment command", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse([
          {
            id: "vehicle-1",
            vehicleModelId: "model-1",
            vin: "VIN-1",
            chassisNumber: "CHASSIS-1",
            engineMotorIdentifier: "ENGINE-1",
            condition: {},
            accessories: [],
            trackerIdentifier: null,
            registrationNumber: "REG-1",
            status: "IN_STOCK",
            version: 2,
          },
        ]),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: "assignment-1",
          applicationId: "application-1",
          vehicleUnitId: "vehicle-1",
          offerId: "offer-1",
          offerVersionId: "offer-version-1",
          depositReconciledAmountMinor: "30000",
          depositEvidenceId: "deposit-1",
          supersedesAssignmentId: null,
          assignedAt: "2026-08-20T12:00:00.000Z",
          version: 1,
        }),
      );
    const api = new FetchStaffApi("", fetcher);
    await expect(api.listInventory()).resolves.toMatchObject([
      { id: "vehicle-1", version: 2 },
    ]);
    await api.assignVehicle("application-1", {
      vehicleUnitId: "vehicle-1",
      expectedVehicleVersion: 2,
      idempotencyKey: "assignment-key-1",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/staff/applications/application-1/asset-assignment",
      expect.objectContaining({
        body: expect.stringContaining('"expectedVehicleVersion":2'),
      }),
    );
  });

  it("uses the authenticated typed collections client for queues and audited actions", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken: "csrf-1",
          staffUserId: "staff-1",
          roles: ["RECOVERY_OFFICER"],
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ status: "APPROVED" }))
      .mockResolvedValueOnce(
        jsonResponse({ locationOnly: true, latitude: 5.6, longitude: -0.2 }),
      );
    const api = new FetchStaffApi("", fetcher);
    await api.login({
      email: "staff@example.test",
      password: "password",
      mfaAssertion: "valid",
    });
    await api.listArrears();
    await api.listCases();
    await api.decideRecoveryCase("case-1", {
      decision: "APPROVED",
      purpose: "review",
      reason: "approved",
      idempotencyKey: "decision-key-1",
    });
    await api.getRecoveryLocation("case-1", "review");
    expect(fetcher.mock.calls[1]?.[0]).toBe("/v1/staff/collections/arrears");
    expect(fetcher.mock.calls[2]?.[0]).toBe("/v1/staff/collections/cases");
    expect(fetcher.mock.calls[3]?.[0]).toBe(
      "/v1/staff/collections/cases/case-1/decision",
    );
    expect(fetcher.mock.calls[3]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "x-csrf-token": "csrf-1" }),
      }),
    );
  });

  it("loads rule/exception lists and sends effective dates and decision reasons", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken: "csrf-1",
          staffUserId: "staff-1",
          roles: ["PRODUCT_ADMIN"],
        }),
      )
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ status: "PUBLISHED", version: 2 }));
    const api = new FetchStaffApi("", fetcher);
    await api.login({
      email: "staff@example.test",
      password: "password",
      mfaAssertion: "valid",
    });
    await api.listRules();
    await api.listExceptions();
    await api.publish("rule-1", {
      effectiveFrom: "2026-08-20T00:00:00.000Z",
      effectiveUntil: "2026-09-20T00:00:00.000Z",
      idempotencyKey: "publish-key-1",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/staff/products/rule-versions/rule-1/publish",
      expect.objectContaining({
        body: expect.stringContaining("effectiveFrom"),
      }),
    );
  });

  it("rejects malformed financing control lists instead of fabricating gate state", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          csrfToken: "csrf-1",
          staffUserId: "staff-1",
          roles: ["PRODUCT_ADMIN"],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([{ id: "rule-1", status: "PUBLISHED" }]),
      );
    const api = new FetchStaffApi("", fetcher);
    await api.login({
      email: "staff@example.test",
      password: "password",
      mfaAssertion: "valid",
    });
    await expect(api.listRules()).rejects.toMatchObject({
      code: "MALFORMED_RULE_LIST",
    });
  });

  it("sends versioned registration, insurance, and attested tracker writes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          vehicleUnitId: "vehicle-1",
          registrationNumber: "REG-1",
          validTo: "2027-01-01",
          version: 2,
          renewalWarningState: "RENEWAL_REVIEW_REQUIRED",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          vehicleUnitId: "vehicle-1",
          policyNumber: "POLICY-1",
          validTo: "2027-01-01",
          version: 3,
          renewalWarningState: "RENEWAL_REVIEW_REQUIRED",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ vehicleUnitId: "vehicle-1", version: 4 }),
      );
    const api = new FetchStaffApi("", fetcher);
    await api.recordRegistration("vehicle-1", {
      registrationNumber: "REG-1",
      validFrom: "2026-01-01",
      validTo: "2027-01-01",
      expectedVehicleVersion: 1,
      idempotencyKey: "registration-key-1",
    });
    await api.recordInsurance("vehicle-1", {
      policyNumber: "POLICY-1",
      provider: "Insurer",
      validFrom: "2026-01-01",
      validTo: "2027-01-01",
      expectedVehicleVersion: 2,
      idempotencyKey: "insurance-key-1",
    });
    await api.associateTracker("vehicle-1", {
      trackerId: "tracker-1",
      expectedVehicleVersion: 3,
      idempotencyKey: "tracker-key-1",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/staff/assets/vehicle-1/tracker",
      expect.objectContaining({
        body: expect.stringContaining('"trackerId":"tracker-1"'),
      }),
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
