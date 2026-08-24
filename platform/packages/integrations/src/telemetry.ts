import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type DependencyStatus = "UP" | "DOWN";

export interface HealthSnapshot {
  status: "ok" | "not_ready";
  dependencies: Readonly<Record<string, DependencyStatus>>;
  queueAgeSeconds: number | null;
  reconciliationVarianceMinorUnits: string | null;
  providerFailures: Readonly<Record<string, number>>;
}

export interface PublicHealthSnapshot {
  status: "ok" | "not_ready";
}

export interface Telemetry {
  correlationId(candidate?: string): string;
  currentCorrelationId(): string | undefined;
  enterCorrelationId(correlationId: string): void;
  withCorrelationId<T>(
    correlationId: string,
    operation: () => Promise<T>,
  ): Promise<T>;
  withJobCorrelation<T extends Record<string, unknown>>(
    payload: T,
    correlationId?: string,
  ): T & { correlationId: string };
  correlationIdFromJob(payload: unknown): string | undefined;
  redactLogRecord(value: unknown): unknown;
  setDependency(name: string, status: DependencyStatus): void;
  recordQueueAge(ageSeconds: number): void;
  recordReconciliationVariance(
    varianceMinorUnits: bigint | string | number,
  ): void;
  recordProviderFailure(provider: string): void;
  liveness(): PublicHealthSnapshot;
  readiness(): PublicHealthSnapshot;
  inspect(): HealthSnapshot;
}

const correlationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const redactedKeyPattern =
  /(?:secret|password|token|authorization|cookie|otp|mfa|code|ghana.?card|identity|phone|email|amount|balance|payment|account|financial|card.?number|document)/i;

export function createTelemetry(): Telemetry {
  const context = new AsyncLocalStorage<string>();
  const dependencies = new Map<string, DependencyStatus>();
  const providerFailures = new Map<string, number>();
  let queueAgeSeconds: number | null = null;
  let reconciliationVarianceMinorUnits: string | null = null;

  const api: Telemetry = {
    correlationId(candidate) {
      return candidate !== undefined && correlationPattern.test(candidate)
        ? candidate.toLowerCase()
        : randomUUID();
    },

    currentCorrelationId() {
      return context.getStore();
    },

    enterCorrelationId(correlationId) {
      context.enterWith(api.correlationId(correlationId));
    },

    async withCorrelationId(correlationId, operation) {
      const normalized = api.correlationId(correlationId);
      return context.run(normalized, operation);
    },

    withJobCorrelation(payload, correlationId) {
      const id = api.correlationId(correlationId ?? context.getStore());
      return {
        ...payload,
        correlationId: id,
        ...(payload.requestId === undefined ? { requestId: id } : {}),
      };
    },

    correlationIdFromJob(payload) {
      if (
        payload === null ||
        typeof payload !== "object" ||
        Array.isArray(payload)
      )
        return undefined;
      const record = payload as Record<string, unknown>;
      const value = record.correlationId ?? record.requestId;
      return typeof value === "string" && correlationPattern.test(value)
        ? value.toLowerCase()
        : undefined;
    },

    redactLogRecord(value) {
      return redact(value);
    },

    setDependency(name, status) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(name))
        throw new Error("TELEMETRY_DEPENDENCY_NAME_INVALID");
      dependencies.set(name, status);
    },

    recordQueueAge(ageSeconds) {
      if (!Number.isFinite(ageSeconds) || ageSeconds < 0)
        throw new Error("TELEMETRY_QUEUE_AGE_INVALID");
      queueAgeSeconds = ageSeconds;
    },

    recordReconciliationVariance(varianceMinorUnits) {
      const value = BigInt(varianceMinorUnits);
      reconciliationVarianceMinorUnits = value.toString();
    },

    recordProviderFailure(provider) {
      if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(provider))
        throw new Error("TELEMETRY_PROVIDER_NAME_INVALID");
      providerFailures.set(provider, (providerFailures.get(provider) ?? 0) + 1);
    },

    liveness() {
      return { status: "ok" };
    },

    readiness() {
      return {
        status:
          dependencies.size > 0 &&
          [...dependencies.values()].every((status) => status === "UP")
            ? "ok"
            : "not_ready",
      };
    },

    inspect() {
      return {
        status: api.readiness().status,
        dependencies: Object.freeze(Object.fromEntries(dependencies)),
        queueAgeSeconds,
        reconciliationVarianceMinorUnits,
        providerFailures: Object.freeze(Object.fromEntries(providerFailures)),
      };
    },
  };
  return Object.freeze(api);
}

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[key] = redactedKeyPattern.test(key) ? "[REDACTED]" : redact(item);
    }
    return result;
  }
  return value;
}
