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

describe("controlled-pilot information request boundary", () => {
  it("returns the application to the requested stage only after public resubmission", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    const detail = await call(
      request,
      runtime.baseUrl,
      "get",
      `/v1/staff/applications/${flow.applicationId}`,
      {
        headers: runtime.staff.get("VERIFICATION_OFFICER")!.headers,
      },
    );
    expect(detail.status()).toBe(200);
    const requestInfo = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/request-information`,
      {
        headers: runtime.staff.get("VERIFICATION_OFFICER")!.headers,
        body: {
          expectedVersion: Number((await body(detail)).version),
          stage: "VERIFICATION",
          note: "Please clarify the residential area.",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(requestInfo.status()).toBe(200);
    await expect(body(requestInfo)).resolves.toMatchObject({
      action: "REQUEST_INFORMATION",
    });
    const requested = await body(requestInfo);
    const resubmitted = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/applications/${flow.applicationId}/resubmissions`,
      {
        headers: runtime.customer.applicant.headers,
        body: {
          expectedVersion: Number(requested.version),
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(resubmitted.status()).toBe(200);
    await expect(body(resubmitted)).resolves.toMatchObject({
      status: "VERIFICATION_REVIEW",
    });
  }, 60_000);
});
