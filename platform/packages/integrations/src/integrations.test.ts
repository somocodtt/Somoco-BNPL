import { describe, expect, it } from "vitest";
import {
  IntegrationTemporaryError,
  createCreditBureauSimulator,
  createErpSimulator,
  createNiaSimulator,
  createPaymentWebhookSimulator,
  createSmsSimulator,
  createTrackerSimulator,
} from "./simulators/index.js";

const checkedAt = "2026-08-14T12:00:00.000Z";

describe("deterministic integration simulators", () => {
  it("returns the configured NIA decision for an exact fixture", async () => {
    const nia = createNiaSimulator({
      environment: "test",
      fixtures: [
        {
          input: {
            correlationId: "correlation-1001",
            ghanaCardNumber: "GHA-000000001-1",
            consentId: "consent-1001",
          },
          result: {
            providerReference: "nia-sim-1001",
            decision: "MATCH",
            checkedAt,
          },
        },
      ],
    });

    await expect(
      nia.verify({
        correlationId: "correlation-1001",
        ghanaCardNumber: "GHA-000000001-1",
        consentId: "consent-1001",
      }),
    ).resolves.toEqual({
      providerReference: "nia-sim-1001",
      decision: "MATCH",
      checkedAt,
    });
    await expect(
      nia.verify({
        correlationId: "correlation-unknown",
        ghanaCardNumber: "GHA-999999999-9",
        consentId: "consent-unknown",
      }),
    ).rejects.toThrow("SIMULATOR_FIXTURE_NOT_FOUND");
  });

  it("returns one SMS acceptance for repeated idempotent sends", async () => {
    const sms = createSmsSimulator({
      environment: "test",
      fixtures: [
        {
          input: {
            idempotencyKey: "notification-1001",
            phoneE164: "+233201234567",
            template: "PAYMENT_RECEIPT",
            variables: { amount: "GHS 125.00" },
          },
          result: {
            providerReference: "sms-sim-1001",
            acceptedAt: checkedAt,
          },
        },
      ],
    });
    const input = {
      idempotencyKey: "notification-1001",
      phoneE164: "+233201234567",
      template: "PAYMENT_RECEIPT",
      variables: { amount: "GHS 125.00" },
    } as const;

    const first = await sms.send(input);
    const duplicate = await sms.send(input);

    expect(first).toEqual({
      providerReference: "sms-sim-1001",
      acceptedAt: checkedAt,
    });
    expect(duplicate).toEqual(first);
  });

  it("exposes tracker fixtures through a read-only lookup", async () => {
    const tracker = createTrackerSimulator({
      environment: "test",
      fixtures: [
        {
          trackerId: "tracker-1001",
          result: {
            latitude: "5.603717",
            longitude: "-0.186964",
            recordedAt: checkedAt,
            deviceStatus: "ONLINE",
          },
        },
      ],
    });

    const result = await tracker.getLastKnown({ trackerId: "tracker-1001" });

    expect(result).toEqual({
      latitude: "5.603717",
      longitude: "-0.186964",
      recordedAt: checkedAt,
      deviceStatus: "ONLINE",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(await tracker.getLastKnown({ trackerId: "missing" })).toBeNull();
  });

  it("keeps the credit-bureau adapter in explicit manual mode", () => {
    const bureau = createCreditBureauSimulator({ environment: "test" });

    expect(bureau.mode).toBe("MANUAL");
  });

  it("rejects a payment webhook that does not match a signature fixture", async () => {
    const rawBody = new TextEncoder().encode('{"eventId":"evt-1001"}');
    const verifier = createPaymentWebhookSimulator({
      environment: "test",
      fixtures: [
        {
          signature: "fixture-signature",
          requestTimestamp: checkedAt,
          rawBody,
          event: {
            eventId: "evt-1001",
            eventType: "PAYMENT_SUCCEEDED",
            providerTransactionId: "txn-1001",
            payerPhoneE164: "+233201234567",
            customerReference: "customer-1001",
            amount: { currency: "GHS", minorUnits: "12500" },
            occurredAt: checkedAt,
          },
        },
      ],
    });

    await expect(
      verifier.verify({
        signature: "invalid-signature",
        requestTimestamp: checkedAt,
        rawBody,
      }),
    ).rejects.toThrow("PAYMENT_SIGNATURE_INVALID");
  });

  it("raises only the configured sanitized ERP temporary failure code", async () => {
    const erp = createErpSimulator({
      environment: "test",
      fixtures: [
        {
          eventId: "event-1001",
          outcome: {
            type: "TEMPORARY_FAILURE",
            code: "ERP_UNAVAILABLE",
          },
        },
      ],
    });

    const error = await erp
      .publish({
        eventId: "event-1001",
        eventType: "PaymentPosted",
        aggregateId: "contract-1001",
        occurredAt: checkedAt,
        payload: { amountMinorUnits: "12500" },
      })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(IntegrationTemporaryError);
    expect(error).toMatchObject({
      code: "ERP_UNAVAILABLE",
      retryable: true,
      message: "INTEGRATION_TEMPORARY_FAILURE",
    });
    expect(JSON.stringify(error)).not.toContain("12500");
  });

  it("rejects every simulator factory in production", () => {
    const factories = [
      () => createNiaSimulator({ environment: "production", fixtures: [] }),
      () => createSmsSimulator({ environment: "production", fixtures: [] }),
      () => createTrackerSimulator({ environment: "production", fixtures: [] }),
      () => createCreditBureauSimulator({ environment: "production" }),
      () =>
        createPaymentWebhookSimulator({
          environment: "production",
          fixtures: [],
        }),
      () => createErpSimulator({ environment: "production", fixtures: [] }),
    ];

    for (const create of factories) {
      expect(create).toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
    }
  });

  it("rejects every simulator when the actual runtime is production despite a test assertion", () => {
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const factories = [
        () => createNiaSimulator({ environment: "test", fixtures: [] }),
        () => createSmsSimulator({ environment: "test", fixtures: [] }),
        () => createTrackerSimulator({ environment: "test", fixtures: [] }),
        () => createCreditBureauSimulator({ environment: "test" }),
        () =>
          createPaymentWebhookSimulator({
            environment: "test",
            fixtures: [],
          }),
        () => createErpSimulator({ environment: "test", fixtures: [] }),
      ];

      for (const create of factories) {
        expect(create).toThrow("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
      }
    } finally {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    }
  });
});
