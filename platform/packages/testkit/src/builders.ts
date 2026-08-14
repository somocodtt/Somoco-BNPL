import { randomUUID } from "node:crypto";

const DEFAULT_OCCURRED_AT = new Date("2026-08-14T12:00:00.000Z");

export function personBuilder(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    phoneE164: `+2332${Math.floor(Math.random() * 100_000_000)
      .toString()
      .padStart(8, "0")}`,
    createdAt: DEFAULT_OCCURRED_AT,
    updatedAt: DEFAULT_OCCURRED_AT,
    ...overrides,
  };
}

export function applicationBuilder(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    applicantPersonId: randomUUID(),
    status: "DRAFT" as const,
    createdAt: DEFAULT_OCCURRED_AT,
    updatedAt: DEFAULT_OCCURRED_AT,
    ...overrides,
  };
}

export function auditBuilder(overrides: Record<string, unknown> = {}) {
  const aggregateId = randomUUID();
  return {
    id: randomUUID(),
    aggregateType: "APPLICATION",
    aggregateId,
    action: "APPLICATION_CREATED",
    data: { status: "DRAFT" },
    occurredAt: DEFAULT_OCCURRED_AT,
    ...overrides,
  };
}

export function outboxBuilder(overrides: Record<string, unknown> = {}) {
  const aggregateId = randomUUID();
  return {
    id: randomUUID(),
    topic: "ApplicationCreated",
    aggregateType: "APPLICATION",
    aggregateId,
    payload: { status: "DRAFT" },
    occurredAt: DEFAULT_OCCURRED_AT,
    ...overrides,
  };
}

export function inboxBuilder(overrides: Record<string, unknown> = {}) {
  return {
    provider: "SOMOCO_PAYMENTS",
    providerEventId: `evt-${randomUUID()}`,
    eventType: "PAYMENT_SUCCEEDED",
    payload: { amount: { currency: "GHS", minorUnits: "12500" } },
    receivedAt: DEFAULT_OCCURRED_AT,
    ...overrides,
  };
}
