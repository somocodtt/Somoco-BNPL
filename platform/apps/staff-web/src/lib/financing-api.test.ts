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
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
