import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startRealPilot, type PilotRuntime } from "./support/real-pilot.js";
import { body, call, completeOnboarding } from "./support/pilot-client.js";
import { createApiRequest } from "./support/vitest-http.js";

let runtime: PilotRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("controlled-pilot recovery boundary", () => {
  it("keeps arrears read-only and denies automatic recovery to support", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    await completeOnboarding(request, runtime);
    const arrears = await call(
      request,
      runtime.baseUrl,
      "get",
      "/v1/staff/collections/arrears",
      {
        headers: runtime.staff.get("RECOVERY_OFFICER")!.headers,
      },
    );
    expect(arrears.status()).toBe(200);
    await expect(arrears.json()).resolves.toEqual([]);
    const forbidden = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/staff/collections/cases",
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: {
          contractId: randomUUID(),
          purpose: "CONTROLLED_PILOT_RECOVERY_ROLE_CHECK",
          reason: "Recovery cases require a recovery authority.",
        },
      },
    );
    expect(forbidden.status()).toBe(403);
    await expect(body(forbidden)).resolves.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);
});
