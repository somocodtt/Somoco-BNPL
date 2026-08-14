import type { SmsPort } from "../sms.js";
import { assertSimulatorAllowed, type SimulatorEnvironment } from "./guard.js";

type SmsInput = Parameters<SmsPort["send"]>[0];
type SmsResult = Awaited<ReturnType<SmsPort["send"]>>;

export interface SmsSimulatorFixture {
  readonly input: SmsInput;
  readonly result: SmsResult;
}

export function createSmsSimulator(options: {
  environment: SimulatorEnvironment;
  fixtures: readonly SmsSimulatorFixture[];
}): SmsPort {
  assertSimulatorAllowed(options.environment);
  const acceptedByKey = new Map<string, SmsResult>();

  return Object.freeze({
    async send(input: SmsInput): Promise<SmsResult> {
      const accepted = acceptedByKey.get(input.idempotencyKey);
      if (accepted !== undefined) {
        return accepted;
      }
      const fixture = options.fixtures.find((candidate) =>
        smsInputMatches(candidate.input, input),
      );
      if (fixture === undefined) {
        throw new Error("SIMULATOR_FIXTURE_NOT_FOUND");
      }
      const result = Object.freeze({ ...fixture.result });
      acceptedByKey.set(input.idempotencyKey, result);
      return result;
    },
  });
}

function smsInputMatches(expected: SmsInput, actual: SmsInput): boolean {
  return (
    expected.idempotencyKey === actual.idempotencyKey &&
    expected.phoneE164 === actual.phoneE164 &&
    expected.template === actual.template &&
    recordsMatch(expected.variables, actual.variables)
  );
}

function recordsMatch(
  expected: Readonly<Record<string, string>>,
  actual: Readonly<Record<string, string>>,
): boolean {
  const keys = Object.keys(expected);
  return (
    keys.length === Object.keys(actual).length &&
    keys.every((key) => expected[key] === actual[key])
  );
}
