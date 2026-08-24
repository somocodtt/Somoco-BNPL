import type { CreditBureauPort } from "../credit-bureau.js";
import { assertSimulatorAllowed, type SimulatorEnvironment } from "./guard.js";
import { markSimulatorAdapter } from "../provenance.js";

export function createCreditBureauSimulator(options: {
  environment: SimulatorEnvironment;
}): CreditBureauPort {
  assertSimulatorAllowed(options.environment);
  return markSimulatorAdapter(Object.freeze({ mode: "MANUAL" as const }));
}
