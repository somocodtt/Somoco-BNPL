import { afterEach, describe, expect, it } from "vitest";
import type { CanonicalPaymentEvent } from "../../../packages/integrations/src/index.js";
import { startRealPilot, type PilotRuntime } from "./support/real-pilot.js";
import {
  approveAllStages,
  body,
  completeOnboarding,
  createAndAcceptOffer,
  postPayment,
} from "./support/pilot-client.js";
import { createApiRequest } from "./support/vitest-http.js";

let runtime: PilotRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("controlled-pilot payment replay boundary", () => {
  it("keeps an unmatched provider payment quarantined and idempotent", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);
    const event: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-spec-replay-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId: "controlled-pilot-spec-provider-001",
      payerPhoneE164: "+233241000001",
      customerReference: "UNKNOWN-CONTROLLED-PILOT-CONTRACT",
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-01T12:30:00.000Z",
    };
    const first = await postPayment(request, flow, event);
    expect(first.status()).toBe(202);
    await expect(body(first)).resolves.toMatchObject({
      outcome: "QUARANTINED",
      duplicate: false,
    });
    const replay = await postPayment(request, flow, {
      ...event,
      eventId: "controlled-pilot-spec-replay-002",
    });
    expect(replay.status()).toBe(202);
    await expect(body(replay)).resolves.toMatchObject({
      outcome: "QUARANTINED",
      duplicate: true,
    });
  }, 60_000);
});
