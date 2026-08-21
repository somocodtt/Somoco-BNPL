import { describe, expect, it } from "vitest";
import { createProductionConnectorBoundary } from "@somo/integrations";
import { createPaymentWebhookSimulator } from "@somo/integrations/simulators";

describe("production payment composition", () => {
  it("requires an attested allocation-policy verifier", async () => {
    const validate = await productionPaymentValidator();
    const connectors = productionConnectors();
    expect(() =>
      validate(
        { environment: "production" },
        { ...connectors, allocationPolicyEvidenceVerifier: undefined },
      ),
    ).toThrow("PRODUCTION_ALLOCATION_POLICY_EVIDENCE_VERIFIER_REQUIRED");
  });

  it("rejects direct and wrapped simulator policy verifiers", async () => {
    const validate = await productionPaymentValidator();
    const connectors = productionConnectors();
    const simulator = createPaymentWebhookSimulator({
      environment: "test",
      fixtures: [],
    });
    expect(() =>
      validate(
        { environment: "production" },
        { ...connectors, allocationPolicyEvidenceVerifier: simulator },
      ),
    ).toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
    expect(() =>
      validate(
        { environment: "production" },
        {
          ...connectors,
          allocationPolicyEvidenceVerifier: {
            verify: (input: Parameters<typeof simulator.verify>[0]) =>
              simulator.verify(input),
          },
        },
      ),
    ).toThrow("PRODUCTION_CONNECTOR_CAPABILITY_REQUIRED");
  });
});

async function productionPaymentValidator(): Promise<
  (config: unknown, payments: unknown) => void
> {
  const api = (await import("../src/app.js")) as Record<string, unknown>;
  return api["validateProductionPaymentDependencies"] as (
    config: unknown,
    payments: unknown,
  ) => void;
}

function productionConnectors() {
  const boundary = createProductionConnectorBoundary();
  return {
    verifier: boundary.register({
      kind: "PAYMENTS",
      provenance: {
        packageName: "@somo-external/somoco-payments",
        packageVersion: "1.0.0",
        connectorId: "somoco-payments",
      },
      adapter: {
        async verify() {
          throw new Error("not called");
        },
      },
    }),
    sms: boundary.register({
      kind: "SMS",
      provenance: {
        packageName: "@somo-external/somoco-sms",
        packageVersion: "1.0.0",
        connectorId: "somoco-sms",
      },
      adapter: {
        async send() {
          return {
            providerReference: "not-called",
            acceptedAt: "2026-08-21T00:00:00.000Z",
          };
        },
      },
    }),
  };
}
