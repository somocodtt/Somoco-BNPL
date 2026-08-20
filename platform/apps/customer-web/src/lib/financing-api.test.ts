import { describe, expect, it, vi } from "vitest";
import { FetchCustomerApi } from "./api.js";

describe("customer financing API adapter", () => {
  it("maps the explicit offer DTO and sends versioned consent", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ sessionToken: "session-1", expiresAt: "2026-08-21T00:00:00.000Z" }))
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
          installments: [{ sequence: 1, dueDate: "2026-09-01", totalMinor: "77000" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ ...({} as object), status: "ACCEPTED", version: 2 }));
    const api = new FetchCustomerApi("", fetcher);
    await api.verifyOtp("+233200000001", "123456");
    const offer = await api.get("application-1");
    expect(offer).toMatchObject({ id: "offer-1", priceMinor: "100000", disclosureVersion: "test-disclosure-v1" });
    await api.accept("offer-1", { consent: true, consentAt: "2026-08-20T12:00:00.000Z" });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/customer/offers/offer-1/accept",
      expect.objectContaining({ body: expect.stringContaining('"expectedVersion":1') }),
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
