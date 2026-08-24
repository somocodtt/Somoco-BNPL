import type { TrackerLocation, TrackerPort } from "../tracker.js";
import { assertSimulatorAllowed, type SimulatorEnvironment } from "./guard.js";
import { markSimulatorAdapter } from "../provenance.js";

export interface TrackerSimulatorFixture {
  readonly trackerId: string;
  readonly result: TrackerLocation;
}

export function createTrackerSimulator(options: {
  environment: SimulatorEnvironment;
  fixtures: readonly TrackerSimulatorFixture[];
}): TrackerPort {
  assertSimulatorAllowed(options.environment);
  return markSimulatorAdapter(
    Object.freeze({
      async getLastKnown(input: {
        trackerId: string;
      }): Promise<TrackerLocation | null> {
        const fixture = options.fixtures.find(
          (candidate) => candidate.trackerId === input.trackerId,
        );
        return fixture === undefined
          ? null
          : Object.freeze({ ...fixture.result });
      },
    }),
  );
}
