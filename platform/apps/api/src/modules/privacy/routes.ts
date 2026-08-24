import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  createCustomerAuthenticationHook,
  createStaffAuthenticationHook,
  requireCustomerPrincipal,
  requireStaffPrincipal,
} from "../../plugins/auth.js";
import type { AccessService } from "../access/service.js";
import type { OtpService } from "../identity/otp-service.js";
import { AppError } from "../../plugins/errors.js";
import type {
  PrivacyRequestStatus,
  PrivacyService,
  PrivacySubjectType,
} from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;
const requestParams = {
  type: "object",
  additionalProperties: false,
  required: ["requestId"],
  properties: { requestId: uuid },
} as const;
const requestBody = {
  type: "object",
  additionalProperties: false,
  required: ["requestType", "subjectType"],
  properties: {
    requestType: {
      type: "string",
      enum: ["ACCESS", "CORRECTION", "RESTRICTION"],
    },
    subjectType: { type: "string", enum: ["APPLICANT", "GUARANTOR"] },
    reason: { type: "string", maxLength: 4_000 },
  },
} as const;

export async function registerPrivacyRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  privacy: PrivacyService,
  customerOtp?: Pick<OtpService, "authenticateSessionToken">,
): Promise<void> {
  const authenticateStaff = createStaffAuthenticationHook(access, config);
  const staffMutation = [authenticateStaff, app.csrfProtection];

  app.get<{
    Querystring: { status?: PrivacyRequestStatus };
  }>(
    "/v1/staff/privacy/requests",
    {
      preHandler: authenticateStaff,
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            status: {
              type: "string",
              enum: ["OPEN", "IN_REVIEW", "COMPLETED", "REJECTED", "CLOSED"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = privacyReadActor(request);
      return reply.send(
        await privacy.listRequests({
          actor,
          ...(request.query.status === undefined
            ? {}
            : { status: request.query.status }),
        }),
      );
    },
  );

  app.post<{
    Params: { requestId: string };
  }>(
    "/v1/staff/privacy/requests/:requestId/review",
    { preHandler: staffMutation, schema: { params: requestParams } },
    async (request, reply) =>
      reply.send(
        await privacy.reviewRequest({
          requestId: request.params.requestId,
          actor: complianceActor(request),
        }),
      ),
  );

  app.post<{
    Params: { requestId: string };
    Body: {
      field: string;
      proposedValue: unknown;
      reason: string;
    };
  }>(
    "/v1/staff/privacy/requests/:requestId/correction",
    {
      preHandler: staffMutation,
      schema: {
        params: requestParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["field", "proposedValue", "reason"],
          properties: {
            field: { type: "string", pattern: "^[a-z][A-Za-z0-9_]{0,63}$" },
            proposedValue: {},
            reason: { type: "string", minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = complianceActor(request);
      const requests = await privacy.listRequests({ actor });
      const target = requests.find(
        (item) => item.id === request.params.requestId,
      );
      if (target === undefined) {
        return reply.code(404).send({ code: "PRIVACY_REQUEST_NOT_FOUND" });
      }
      return reply.send(
        await privacy.recordCorrection({
          requestId: request.params.requestId,
          subjectId: target.subjectId,
          ...request.body,
          actor,
        }),
      );
    },
  );

  app.post<{
    Params: { requestId: string };
    Body: { reason: string };
  }>(
    "/v1/staff/privacy/requests/:requestId/restriction",
    {
      preHandler: staffMutation,
      schema: {
        params: requestParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["reason"],
          properties: {
            reason: { type: "string", minLength: 1, maxLength: 4_000 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = complianceActor(request);
      const target = (await privacy.listRequests({ actor })).find(
        (item) => item.id === request.params.requestId,
      );
      if (target === undefined) {
        return reply.code(404).send({ code: "PRIVACY_REQUEST_NOT_FOUND" });
      }
      return reply.send(
        await privacy.restrictProcessing({
          requestId: target.id,
          subjectId: target.subjectId,
          reason: request.body.reason,
          actor,
        }),
      );
    },
  );

  app.post<{
    Params: { requestId: string };
    Body: { outcome?: "COMPLETED" | "REJECTED" };
  }>(
    "/v1/staff/privacy/requests/:requestId/close",
    {
      preHandler: staffMutation,
      schema: {
        params: requestParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            outcome: { type: "string", enum: ["COMPLETED", "REJECTED"] },
          },
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await privacy.closeRequest({
          requestId: request.params.requestId,
          ...(request.body.outcome === undefined
            ? {}
            : { outcome: request.body.outcome }),
          actor: complianceActor(request),
        }),
      ),
  );

  app.post<{
    Body: { policyVersion: string; asOf?: string; retentionDays?: number };
  }>(
    "/v1/staff/privacy/retention/apply",
    {
      preHandler: staffMutation,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["policyVersion"],
          properties: {
            policyVersion: { type: "string", minLength: 1, maxLength: 64 },
            asOf: { type: "string", format: "date-time" },
            retentionDays: { type: "integer", minimum: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = complianceActor(request);
      if (request.body.retentionDays !== undefined) {
        await privacy.approveRetentionPolicy({
          version: request.body.policyVersion,
          retentionDays: request.body.retentionDays,
          actor,
        });
      }
      return reply.send(
        await privacy.applyRetention({
          policyVersion: request.body.policyVersion,
          ...(request.body.asOf === undefined
            ? {}
            : { asOf: new Date(request.body.asOf) }),
          actor,
        }),
      );
    },
  );

  if (customerOtp !== undefined) {
    const authenticateCustomer = createCustomerAuthenticationHook(customerOtp);
    app.post<{
      Body: {
        requestType: "ACCESS" | "CORRECTION" | "RESTRICTION";
        subjectType: PrivacySubjectType;
        reason?: string;
      };
    }>(
      "/v1/customer/privacy/requests",
      {
        preHandler: authenticateCustomer,
        schema: { body: requestBody },
      },
      async (request, reply) => {
        const principal = requireCustomerPrincipal(request);
        return reply.code(201).send(
          await privacy.openRequest({
            subjectId: principal.personId,
            ...request.body,
            requestedBy: principal.personId,
          }),
        );
      },
    );
    app.get(
      "/v1/customer/privacy/requests",
      { preHandler: authenticateCustomer },
      async (request, reply) =>
        reply.send(
          await privacy.listRequests({
            subjectId: requireCustomerPrincipal(request).personId,
          }),
        ),
    );
    app.get<{ Params: { requestId: string } }>(
      "/v1/customer/privacy/requests/:requestId/export",
      {
        preHandler: authenticateCustomer,
        schema: { params: requestParams },
      },
      async (request, reply) => {
        const subjectId = requireCustomerPrincipal(request).personId;
        return reply.send(
          await privacy.exportSubjectData({
            requestId: request.params.requestId,
            subjectId,
          }),
        );
      },
    );
  }
}

function complianceActor(request: Parameters<typeof requireStaffPrincipal>[0]) {
  const principal = requireStaffPrincipal(request);
  const role = principal.roles.find((item) =>
    ["COMPLIANCE_OFFICER", "DPO"].includes(item),
  );
  if (role === undefined) {
    throw new AppError(
      403,
      "PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED",
      "Privacy compliance authorization is required.",
    );
  }
  return { id: principal.staffUserId, role };
}

function privacyReadActor(
  request: Parameters<typeof requireStaffPrincipal>[0],
) {
  const principal = requireStaffPrincipal(request);
  const role = principal.roles.find((item) =>
    ["COMPLIANCE_OFFICER", "COMPLIANCE_AUDITOR", "DPO"].includes(item),
  );
  if (role === undefined) {
    throw new AppError(
      403,
      "PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED",
      "Privacy compliance authorization is required.",
    );
  }
  return { id: principal.staffUserId, role };
}
