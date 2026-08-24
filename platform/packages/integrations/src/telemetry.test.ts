import { describe, expect, it } from "vitest";
import { createTelemetry } from "./telemetry.js";

describe("telemetry controls", () => {
  it("propagates correlation IDs into jobs and redacts sensitive values", async () => {
    const telemetry = createTelemetry();
    const correlationId = "00000000-0000-4000-8000-000000000099";
    const job = telemetry.withJobCorrelation(
      { topic: "identity.otp_sms_requested", otp: "123456" },
      correlationId,
    );
    expect(job.correlationId).toBe(correlationId);
    expect(telemetry.correlationIdFromJob(job)).toBe(correlationId);
    expect(
      telemetry.redactLogRecord({
        password: "secret",
        otp: "123456",
        ghanaCardNumber: "GHA-123",
        amountMinorUnits: "100",
        safe: "ok",
      }),
    ).toEqual({
      password: "[REDACTED]",
      otp: "[REDACTED]",
      ghanaCardNumber: "[REDACTED]",
      amountMinorUnits: "[REDACTED]",
      safe: "ok",
    });
    await telemetry.withCorrelationId(correlationId, async () => {
      expect(telemetry.currentCorrelationId()).toBe(correlationId);
    });
  });

  it("keeps public health separate from dependency details and tracks operations", () => {
    const telemetry = createTelemetry();
    telemetry.setDependency("postgres", "UP");
    telemetry.setDependency("object-storage", "DOWN");
    telemetry.recordQueueAge(42);
    telemetry.recordReconciliationVariance(-7n);
    telemetry.recordProviderFailure("SMS");
    expect(telemetry.liveness()).toEqual({ status: "ok" });
    expect(telemetry.readiness()).toEqual({ status: "not_ready" });
    expect(telemetry.inspect()).toMatchObject({
      dependencies: { postgres: "UP", "object-storage": "DOWN" },
      queueAgeSeconds: 42,
      reconciliationVarianceMinorUnits: "-7",
      providerFailures: { SMS: 1 },
    });
  });
});
