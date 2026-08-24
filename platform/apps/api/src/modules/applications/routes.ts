import type { FastifyInstance } from "fastify";
import {
  createCustomerAuthenticationHook,
  requireCustomerPrincipal,
} from "../../plugins/auth.js";
import type { OtpService } from "../identity/otp-service.js";
import type { ApplicationService } from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;
const version = { type: "integer", minimum: 1 } as const;
const profile = {
  type: "object",
  minProperties: 1,
  additionalProperties: true,
} as const;
const applicationParams = {
  type: "object",
  additionalProperties: false,
  required: ["applicationId"],
  properties: { applicationId: uuid },
} as const;
const applicantBody = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "mutationId", "vehicleModelId", "profile"],
  properties: {
    expectedVersion: version,
    mutationId: uuid,
    productId: uuid,
    vehicleModelId: uuid,
    profile,
  },
} as const;
const inviteBody = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "mutationId", "guarantorPhoneE164"],
  properties: {
    expectedVersion: version,
    mutationId: uuid,
    guarantorPhoneE164: { type: "string", pattern: "^\\+233[1-9][0-9]{8}$" },
  },
} as const;
const guarantorBody = {
  type: "object",
  additionalProperties: false,
  required: ["invitationToken", "expectedVersion", "mutationId", "profile"],
  properties: {
    invitationToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
    expectedVersion: version,
    mutationId: uuid,
    profile,
  },
} as const;
const invitationResolutionBody = {
  type: "object",
  additionalProperties: false,
  required: ["invitationToken"],
  properties: {
    invitationToken: { type: "string", pattern: "^[A-Za-z0-9_-]{43}$" },
  },
} as const;
const submitBody = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "mutationId"],
  properties: { expectedVersion: version, mutationId: uuid },
} as const;
const signatureBody = {
  type: "object",
  additionalProperties: false,
  required: ["signature", "idempotencyKey"],
  properties: {
    signature: { type: "string", minLength: 8, maxLength: 4096 },
    idempotencyKey: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$",
    },
  },
} as const;

export async function registerApplicationRoutes(
  app: FastifyInstance,
  otp: Pick<OtpService, "authenticateSessionToken">,
  service: ApplicationService,
): Promise<void> {
  const authenticate = createCustomerAuthenticationHook(otp);
  const signatureMutationPreHandler =
    app.csrfProtection === undefined
      ? authenticate
      : [authenticate, app.csrfProtection];

  app.get(
    "/v1/customer/vehicle-models",
    { preHandler: authenticate },
    async (_request, reply) => reply.send(await service.listVehicleModels()),
  );

  app.post(
    "/v1/customer/applications",
    { preHandler: authenticate },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      const draft = await service.createDraft(context(principal, request.id));
      return reply.code(201).send(draft);
    },
  );

  app.get(
    "/v1/customer/applications/resume",
    { preHandler: authenticate },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      return reply.send(await service.resume(context(principal, request.id)));
    },
  );

  app.patch<{
    Params: { applicationId: string };
    Body: {
      expectedVersion: number;
      mutationId: string;
      productId?: string;
      vehicleModelId: string;
      profile: Record<string, unknown>;
    };
  }>(
    "/v1/customer/applications/:applicationId/applicant",
    {
      schema: { params: applicationParams, body: applicantBody },
      preHandler: authenticate,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      return reply.send(
        await service.saveApplicant(
          request.params.applicationId,
          context(principal, request.id),
          request.body,
        ),
      );
    },
  );

  app.post<{ Body: { invitationToken: string } }>(
    "/v1/customer/guarantor-invitations/resolutions",
    {
      schema: { body: invitationResolutionBody },
      preHandler: authenticate,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      return reply.send(
        await service.resolveGuarantorInvitation(
          request.body.invitationToken,
          context(principal, request.id),
        ),
      );
    },
  );

  app.post<{
    Params: { applicationId: string };
    Body: {
      expectedVersion: number;
      mutationId: string;
      guarantorPhoneE164: string;
    };
  }>(
    "/v1/customer/applications/:applicationId/guarantor-invitations",
    {
      schema: { params: applicationParams, body: inviteBody },
      preHandler: authenticate,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      const invitation = await service.inviteGuarantor(
        request.params.applicationId,
        context(principal, request.id),
        request.body,
      );
      return reply.code(201).send(invitation);
    },
  );

  app.patch<{
    Body: {
      invitationToken: string;
      expectedVersion: number;
      mutationId: string;
      profile: Record<string, unknown>;
    };
  }>(
    "/v1/customer/guarantor",
    { schema: { body: guarantorBody }, preHandler: authenticate },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      const { invitationToken, ...input } = request.body;
      return reply.send(
        await service.saveGuarantor(
          invitationToken,
          context(principal, request.id),
          input,
        ),
      );
    },
  );

  app.get<{ Params: { applicationId: string } }>(
    "/v1/customer/applications/:applicationId/completeness",
    { schema: { params: applicationParams }, preHandler: authenticate },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      return reply.send(
        await service.getCompleteness(
          request.params.applicationId,
          context(principal, request.id),
        ),
      );
    },
  );

  app.post<{
    Params: { applicationId: string };
    Body: { expectedVersion: number; mutationId: string };
  }>(
    "/v1/customer/applications/:applicationId/submissions",
    {
      schema: { params: applicationParams, body: submitBody },
      preHandler: authenticate,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      return reply.send(
        await service.submit(
          request.params.applicationId,
          context(principal, request.id),
          request.body,
        ),
      );
    },
  );

  app.post<{
    Params: { applicationId: string };
    Body: { signature: string; idempotencyKey: string };
  }>(
    "/v1/customer/applications/:applicationId/signatures",
    {
      schema: { params: applicationParams, body: signatureBody },
      preHandler: signatureMutationPreHandler,
    },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      return reply
        .code(201)
        .send(
          await service.recordSignature(
            request.params.applicationId,
            context(principal, request.id),
            request.body,
          ),
        );
    },
  );
}

function context(
  principal: { personId: string; sessionId: string },
  requestId: string,
) {
  return {
    personId: principal.personId,
    sessionId: principal.sessionId,
    requestId,
  };
}
