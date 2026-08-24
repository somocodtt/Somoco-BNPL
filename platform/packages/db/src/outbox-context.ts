import { AsyncLocalStorage } from "node:async_hooks";

const correlationPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const context = new AsyncLocalStorage<string>();

export function enterOutboxCorrelationId(correlationId: string): void {
  if (!correlationPattern.test(correlationId))
    throw new Error("OUTBOX_CORRELATION_ID_INVALID");
  context.enterWith(correlationId.toLowerCase());
}

export function currentOutboxCorrelationId(): string | undefined {
  return context.getStore();
}
