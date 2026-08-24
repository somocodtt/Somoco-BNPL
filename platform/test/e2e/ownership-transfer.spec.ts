import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { startRealPilot, type PilotRuntime } from "./support/real-pilot.js";
import {
  body,
  call,
  completeOnboarding,
  createAndAcceptOffer,
  approveAllStages,
  prepareContractWithoutSignatures,
} from "./support/pilot-client.js";
import { createApiRequest } from "./support/vitest-http.js";

let runtime: PilotRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("controlled-pilot ownership boundary", () => {
  it("does not invent a contract or ownership transfer before public gates exist", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);
    const transfer = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${randomUUID()}/ownership-transfer`,
      {
        headers: runtime.staff.get("MD")!.headers,
      },
    );
    expect(transfer.status()).toBe(404);
    await expect(body(transfer)).resolves.toMatchObject({
      code: "CONTRACT_NOT_FOUND",
    });
  }, 60_000);

  it("denies ownership transfer while a real contract balance remains outstanding", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    const contract = await prepareContractWithoutSignatures(request, flow);
    const transfer = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contract.contractId}/ownership-transfer`,
      { headers: runtime.staff.get("MD")!.headers },
    );
    expect(transfer.status()).toBe(409);
    await expect(body(transfer)).resolves.toMatchObject({
      code: "CONTRACT_NOT_SETTLED",
    });
  }, 60_000);
});
