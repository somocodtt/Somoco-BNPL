import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { enterOutboxCorrelationId } from "@somo/db";
import type { Telemetry } from "@somo/integrations";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function requestIdFromHeader(
  header: string | string[] | undefined,
): string {
  return typeof header === "string" && uuidPattern.test(header)
    ? header.toLowerCase()
    : randomUUID();
}

export async function registerRequestContext(
  app: FastifyInstance,
  telemetry?: Telemetry,
): Promise<void> {
  app.addHook("onRequest", async (request) => {
    const correlationId =
      telemetry?.correlationId(request.id) ?? requestIdFromHeader(request.id);
    telemetry?.enterCorrelationId(correlationId);
    enterOutboxCorrelationId(correlationId);
  });
  app.addHook("onSend", async (request, reply) => {
    void reply.header("x-request-id", request.id);
  });
}
