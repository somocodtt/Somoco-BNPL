import { describe, expect, it, vi } from "vitest";
import { FetchCustomerApi } from "./api.js";

describe("customer financing API adapter", () => {
  it("loads the customer-safe contract DTO without internal identifiers", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionToken: "session-1",
          expiresAt: "2026-08-21T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          contractId: "contract-1",
          status: "EXECUTED",
          previewAvailable: true,
          executed: true,
          assignedVehicleAvailable: false,
          ownershipHolder: "SOMOCO",
          vehicleStatus: "AVAILABLE",
          registrationOwner: null,
          registrationNumber: null,
          registrationValidTo: null,
          insuranceValidTo: null,
          handoverAcknowledged: false,
          schedule: [],
          canonicalHash: "should-not-be-used",
        }),
      );
    const api = new FetchCustomerApi("", fetcher);
    await api.verifyOtp("+233200000001", "123456");
    await expect(api.getContract("application-1")).resolves.toMatchObject({
      status: "EXECUTED",
      executed: true,
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/customer/applications/application-1/contract",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });

  it("loads authenticated account status and reminders through the typed collections client", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionToken: "session-1",
          expiresAt: "2026-08-21T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse([
          {
            contractId: "contract-1",
            contractStatus: "ACTIVE",
            outstandingBalanceMinorUnits: "10000",
            nextDueDate: "2026-09-01",
            overdueMinorUnits: "0",
            consecutiveMissedPayments: 0,
            totalUnpaidPayments: 0,
            signals: [],
            cashAccepted: false,
          },
        ]),
      )
      .mockResolvedValueOnce(jsonResponse([]));
    const api = new FetchCustomerApi("", fetcher);
    await api.verifyOtp("+233200000001", "123456");
    await expect(api.getAccountStatus()).resolves.toMatchObject([
      { contractId: "contract-1", cashAccepted: false },
    ]);
    await expect(api.listReminders()).resolves.toEqual([]);
    expect(fetcher.mock.calls[1]?.[0]).toBe("/v1/customer/account-status");
    expect(fetcher.mock.calls[2]?.[0]).toBe("/v1/customer/reminders");
  });

  it("maps the explicit offer DTO and sends versioned consent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionToken: "session-1",
          expiresAt: "2026-08-21T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          offerId: "offer-1",
          applicationId: "application-1",
          status: "PENDING",
          version: 1,
          expiresAt: "2026-08-21T00:00:00.000Z",
          priceMinor: "100000",
          depositMinor: "30000",
          frequency: "MONTHLY",
          tenureMonths: 6,
          financeChargeMinor: "7000",
          totalPayableMinor: "77000",
          fees: {},
          disclosureVersion: "test-disclosure-v1",
          disclosedHash: "a".repeat(64),
          disclosureContent: {
            version: "test-disclosure-v1",
            body: "Synthetic test disclosure",
          },
          installments: [
            { sequence: 1, dueDate: "2026-09-01", totalMinor: "77000" },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          offerId: "offer-1",
          applicationId: "application-1",
          status: "ACCEPTED",
          version: 2,
          expiresAt: "2026-08-21T00:00:00.000Z",
          priceMinor: "100000",
          depositMinor: "30000",
          frequency: "MONTHLY",
          tenureMonths: 6,
          financeChargeMinor: "7000",
          totalPayableMinor: "77000",
          fees: {},
          disclosureVersion: "test-disclosure-v1",
          disclosedHash: "a".repeat(64),
          disclosureContent: {
            version: "test-disclosure-v1",
            body: "Synthetic test disclosure",
          },
          installments: [
            { sequence: 1, dueDate: "2026-09-01", totalMinor: "77000" },
          ],
        }),
      );
    const api = new FetchCustomerApi("", fetcher);
    await api.verifyOtp("+233200000001", "123456");
    const offer = await api.get("application-1");
    expect(offer).toMatchObject({
      id: "offer-1",
      priceMinor: "100000",
      disclosureVersion: "test-disclosure-v1",
    });
    await api.accept("offer-1", {
      consent: true,
      consentAt: "2026-08-20T12:00:00.000Z",
      disclosedVersion: "test-disclosure-v1",
      disclosedHash: "a".repeat(64),
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/customer/offers/offer-1/accept",
      expect.objectContaining({
        body: expect.stringContaining('"expectedVersion":1'),
      }),
    );
    expect(
      JSON.parse((fetcher.mock.lastCall?.[1] as RequestInit).body as string),
    ).toMatchObject({
      consent: true,
      disclosedVersion: "test-disclosure-v1",
      disclosedHash: "a".repeat(64),
    });
  });

  it("rejects malformed or incomplete public offer DTOs without defaulting money", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          sessionToken: "session-1",
          expiresAt: "2026-08-21T00:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ offerId: "offer-1", status: "PENDING", version: 1 }),
      );
    const api = new FetchCustomerApi("", fetcher);
    await api.verifyOtp("+233200000001", "123456");
    await expect(api.get("application-1")).rejects.toMatchObject({
      code: "MALFORMED_OFFER_DTO",
    });
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
