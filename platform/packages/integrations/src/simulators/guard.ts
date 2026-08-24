export type SimulatorEnvironment = "development" | "test" | "production";

export function assertSimulatorAllowed(
  environment: SimulatorEnvironment,
): void {
  if (environment === "production" || process.env.NODE_ENV === "production") {
    throw new Error("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
  }
}
