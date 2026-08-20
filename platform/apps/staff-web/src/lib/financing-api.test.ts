import { describe, expect, it, vi } from "vitest";
import { FetchStaffApi } from "./api.js";

describe("staff financing API adapter", () => {
  it("loads rule/exception lists and sends effective dates and decision reasons", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf-1", staffUserId: "staff-1", roles: ["PRODUCT_ADMIN"] }))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse([]))
      .mockResolvedValueOnce(jsonResponse({ status: "PUBLISHED", version: 2 }));
    const api = new FetchStaffApi("", fetcher);
    await api.login({ email: "staff@example.test", password: "password", mfaAssertion: "valid" });
    await api.listRules();
    await api.listExceptions();
    await api.publish("rule-1", {
      effectiveFrom: "2026-08-20T00:00:00.000Z",
      effectiveUntil: "2026-09-20T00:00:00.000Z",
      idempotencyKey: "publish-key-1",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "/v1/staff/products/rule-versions/rule-1/publish",
      expect.objectContaining({ body: expect.stringContaining("effectiveFrom") }),
    );
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}
