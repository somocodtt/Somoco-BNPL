export interface ErpPort {
  publish(event: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    occurredAt: string;
    payload: unknown;
  }): Promise<{ externalReference: string }>;
}

export class IntegrationTemporaryError extends Error {
  readonly code: string;
  readonly retryable = true;

  constructor(code: string) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      throw new Error("INTEGRATION_FAILURE_CODE_INVALID");
    }
    super("INTEGRATION_TEMPORARY_FAILURE");
    this.name = "IntegrationTemporaryError";
    this.code = code;
  }
}
