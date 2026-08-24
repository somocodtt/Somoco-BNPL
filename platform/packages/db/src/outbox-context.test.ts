import { describe, expect, it } from "vitest";
import {
  currentOutboxCorrelationId,
  enterOutboxCorrelationId,
} from "./outbox-context.js";

describe("durable outbox correlation context", () => {
  it("carries the request correlation ID into outbox writes", () => {
    const correlationId = "00000000-0000-4000-8000-000000000103";
    enterOutboxCorrelationId(correlationId);
    expect(currentOutboxCorrelationId()).toBe(correlationId);
  });
});
