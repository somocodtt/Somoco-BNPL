import type { FastifyInstance } from "fastify";
import {
  createCustomerAuthenticationHook,
  requireCustomerPrincipal,
} from "../../plugins/auth.js";
import type { OtpService } from "../identity/otp-service.js";
import type { DocumentService } from "./service.js";

const documentIdParamsSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentId"],
  properties: { documentId: { type: "string", format: "uuid" } },
} as const;

const uploadDeclarationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["documentType", "mimeType", "sizeBytes"],
  properties: {
    documentType: {
      type: "string",
      pattern: "^[A-Z][A-Z0-9_]{1,63}$",
    },
    mimeType: { type: "string", minLength: 3, maxLength: 127 },
    sizeBytes: { type: "integer", minimum: 1 },
  },
} as const;

export async function registerDocumentRoutes(
  app: FastifyInstance,
  otp: Pick<OtpService, "authenticateSessionToken">,
  service: DocumentService,
): Promise<void> {
  const authenticateCustomer = createCustomerAuthenticationHook(otp);

  app.post<{
    Body: { documentType: string; mimeType: string; sizeBytes: number };
  }>(
    "/v1/customer/documents/uploads",
    {
      schema: { body: uploadDeclarationSchema },
      preHandler: authenticateCustomer,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      const ticket = await service.requestUpload({
        personId: principal.personId,
        sessionId: principal.sessionId,
        ...request.body,
        requestId: request.id,
      });
      return reply.code(201).send(ticket);
    },
  );

  app.post<{ Params: { documentId: string } }>(
    "/v1/customer/documents/:documentId/complete",
    {
      schema: { params: documentIdParamsSchema },
      preHandler: authenticateCustomer,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      const completed = await service.completeUpload({
        personId: principal.personId,
        sessionId: principal.sessionId,
        documentId: request.params.documentId,
        requestId: request.id,
      });
      return reply.send(completed);
    },
  );

  app.get<{ Params: { documentId: string } }>(
    "/v1/customer/documents/:documentId/download",
    {
      schema: { params: documentIdParamsSchema },
      preHandler: authenticateCustomer,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      const ticket = await service.requestDownload({
        personId: principal.personId,
        sessionId: principal.sessionId,
        documentId: request.params.documentId,
        requestId: request.id,
      });
      return reply.send(ticket);
    },
  );
}
