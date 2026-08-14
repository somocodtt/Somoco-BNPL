import { IntegrationTemporaryError, type ErpPort } from "../erp.js";
import { assertSimulatorAllowed, type SimulatorEnvironment } from "./guard.js";

export type ErpSimulatorOutcome =
  | { readonly type: "SUCCESS"; readonly externalReference: string }
  | { readonly type: "TEMPORARY_FAILURE"; readonly code: string };

export interface ErpSimulatorFixture {
  readonly eventId: string;
  readonly outcome: ErpSimulatorOutcome;
}

export function createErpSimulator(options: {
  environment: SimulatorEnvironment;
  fixtures: readonly ErpSimulatorFixture[];
}): ErpPort {
  assertSimulatorAllowed(options.environment);
  return Object.freeze({
    async publish(
      event: Parameters<ErpPort["publish"]>[0],
    ): Promise<{ externalReference: string }> {
      const fixture = options.fixtures.find(
        (candidate) => candidate.eventId === event.eventId,
      );
      if (fixture === undefined) {
        throw new Error("SIMULATOR_FIXTURE_NOT_FOUND");
      }
      if (fixture.outcome.type === "TEMPORARY_FAILURE") {
        throw new IntegrationTemporaryError(fixture.outcome.code);
      }
      return Object.freeze({
        externalReference: fixture.outcome.externalReference,
      });
    },
  });
}
