import type {
  CanonicalPaymentEvent,
  PaymentWebhookVerifier,
} from "../payments.js";
import { assertSimulatorAllowed, type SimulatorEnvironment } from "./guard.js";
import { markSimulatorAdapter } from "../provenance.js";

export interface PaymentWebhookSimulatorFixture {
  readonly rawBody: Uint8Array;
  readonly signature: string;
  readonly requestTimestamp: string;
  readonly event: CanonicalPaymentEvent;
}

export function createPaymentWebhookSimulator(options: {
  environment: SimulatorEnvironment;
  fixtures: readonly PaymentWebhookSimulatorFixture[];
}): PaymentWebhookVerifier {
  assertSimulatorAllowed(options.environment);
  return markSimulatorAdapter(
    Object.freeze({
      async verify(input: {
        rawBody: Uint8Array;
        signature: string;
        requestTimestamp: string;
      }): Promise<CanonicalPaymentEvent> {
        const fixture = options.fixtures.find(
          (candidate) =>
            candidate.signature === input.signature &&
            candidate.requestTimestamp === input.requestTimestamp &&
            bytesMatch(candidate.rawBody, input.rawBody),
        );
        if (fixture === undefined) {
          throw new Error("PAYMENT_SIGNATURE_INVALID");
        }
        return clonePaymentEvent(fixture.event);
      },
    }),
  );
}

function bytesMatch(expected: Uint8Array, actual: Uint8Array): boolean {
  return (
    expected.byteLength === actual.byteLength &&
    expected.every((value, index) => value === actual[index])
  );
}

function clonePaymentEvent(
  event: CanonicalPaymentEvent,
): CanonicalPaymentEvent {
  return Object.freeze({
    ...event,
    amount: Object.freeze({ ...event.amount }),
  });
}
