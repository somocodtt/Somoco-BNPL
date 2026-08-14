import type { CreditBureauPort } from "../credit-bureau.js";
import { assertSimulatorAllowed, type SimulatorEnvironment } from "./guard.js";

export function createCreditBureauSimulator(options: {
  environment: SimulatorEnvironment;
}): CreditBureauPort {
  assertSimulatorAllowed(options.environment);
  return Object.freeze({ mode: "MANUAL" as const });
}
