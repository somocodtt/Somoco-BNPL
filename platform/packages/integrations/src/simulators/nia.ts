import type { NiaPort } from "../nia.js";
import { assertSimulatorAllowed, type SimulatorEnvironment } from "./guard.js";
import { markSimulatorAdapter } from "../provenance.js";

type NiaInput = Parameters<NiaPort["verify"]>[0];
type NiaResult = Awaited<ReturnType<NiaPort["verify"]>>;

export interface NiaSimulatorFixture {
  readonly input: NiaInput;
  readonly result: NiaResult;
}

export function createNiaSimulator(options: {
  environment: SimulatorEnvironment;
  fixtures: readonly NiaSimulatorFixture[];
}): NiaPort {
  assertSimulatorAllowed(options.environment);
  return markSimulatorAdapter(
    Object.freeze({
      async verify(input: NiaInput): Promise<NiaResult> {
        const fixture = options.fixtures.find(
          (candidate) =>
            candidate.input.correlationId === input.correlationId &&
            candidate.input.ghanaCardNumber === input.ghanaCardNumber &&
            candidate.input.consentId === input.consentId,
        );
        if (fixture === undefined) {
          throw new Error("SIMULATOR_FIXTURE_NOT_FOUND");
        }
        return Object.freeze({ ...fixture.result });
      },
    }),
  );
}
