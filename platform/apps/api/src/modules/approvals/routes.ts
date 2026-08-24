import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  createCustomerAuthenticationHook,
  createStaffAuthenticationHook,
  requireCustomerPrincipal,
  requireStaffPrincipal,
} from "../../plugins/auth.js";
import type { OtpService } from "../identity/otp-service.js";
import type { AccessService } from "../access/service.js";
import type { ApprovalService } from "./service.js";
import type { UnderwritingService } from "./underwriting-service.js";
import type { ApprovalStage } from "./policy.js";

const uuid = { type: "string", format: "uuid" } as const;
const version = { type: "integer", minimum: 1 } as const;
const stage = {
  type: "string",
  enum: ["VERIFICATION", "BSM_INITIAL", "AGM", "CFO", "BSM_FINAL", "MD"],
} as const;
const commandBody = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "stage", "note", "idempotencyKey"],
  properties: {
    expectedVersion: version,
    stage,
    note: { type: "string", minLength: 1, maxLength: 4_000 },
    idempotencyKey: uuid,
  },
} as const;
const bureauBody = {
  type: "object",
  additionalProperties: false,
  required: [
    "expectedVersion",
    "result",
    "checkedAt",
    "bureauReference",
    "evidenceDocumentId",
    "idempotencyKey",
  ],
  properties: {
    expectedVersion: version,
    result: { type: "string", enum: ["CLEAN", "ADVERSE", "REVIEW"] },
    checkedAt: { type: "string", format: "date-time" },
    bureauReference: { type: "string", minLength: 2, maxLength: 128 },
    evidenceDocumentId: uuid,
    idempotencyKey: uuid,
  },
} as const;
const resubmitBody = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion", "idempotencyKey"],
  properties: { expectedVersion: version, idempotencyKey: uuid },
} as const;
const applicationParams = {
  type: "object",
  additionalProperties: false,
  required: ["applicationId"],
  properties: { applicationId: uuid },
} as const;

export async function registerApprovalRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  approvals: ApprovalService,
  underwriting: UnderwritingService,
  otp?: Pick<OtpService, "authenticateSessionToken">,
): Promise<void> {
  const authenticateStaff = createStaffAuthenticationHook(access, config);
  const staffMutationPreHandlers = [authenticateStaff, app.csrfProtection];

  app.get(
    "/v1/staff/applications/queue",
    { preHandler: authenticateStaff },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.send(await approvals.getQueue({ actor }));
    },
  );

  app.get<{ Params: { applicationId: string } }>(
    "/v1/staff/applications/:applicationId",
    { schema: { params: applicationParams }, preHandler: authenticateStaff },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.send(
        await approvals.getApplication({
          actor,
          applicationId: request.params.applicationId,
        }),
      );
    },
  );

  app.post<{
    Params: { applicationId: string };
    Body: {
      expectedVersion: number;
      stage: ApprovalStage;
      note: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/approve",
    {
      schema: { params: applicationParams, body: commandBody },
      preHandler: staffMutationPreHandlers,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.send(
        await approvals.approve({
          applicationId: request.params.applicationId,
          ...request.body,
          actor,
          requestId: request.id,
        }),
      );
    },
  );

  app.post<{
    Params: { applicationId: string };
    Body: {
      expectedVersion: number;
      stage: ApprovalStage;
      note: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/reject",
    {
      schema: { params: applicationParams, body: commandBody },
      preHandler: staffMutationPreHandlers,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.send(
        await approvals.reject({
          applicationId: request.params.applicationId,
          ...request.body,
          actor,
          requestId: request.id,
        }),
      );
    },
  );

  app.post<{
    Params: { applicationId: string };
    Body: {
      expectedVersion: number;
      stage: ApprovalStage;
      note: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/request-information",
    {
      schema: { params: applicationParams, body: commandBody },
      preHandler: staffMutationPreHandlers,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.send(
        await approvals.requestInformation({
          applicationId: request.params.applicationId,
          ...request.body,
          actor,
          requestId: request.id,
        }),
      );
    },
  );

  app.post<{
    Params: { applicationId: string };
    Body: {
      expectedVersion: number;
      result: "CLEAN" | "ADVERSE" | "REVIEW";
      checkedAt: string;
      bureauReference: string;
      evidenceDocumentId: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/credit-bureau-checks",
    {
      schema: { params: applicationParams, body: bureauBody },
      preHandler: staffMutationPreHandlers,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.code(201).send(
        await underwriting.recordManualCreditBureauCheck({
          applicationId: request.params.applicationId,
          ...request.body,
          actor,
          requestId: request.id,
        }),
      );
    },
  );

  if (otp !== undefined) {
    const authenticateCustomer = createCustomerAuthenticationHook(otp);
    app.post<{
      Params: { applicationId: string };
      Body: { expectedVersion: number; idempotencyKey: string };
    }>(
      "/v1/customer/applications/:applicationId/resubmissions",
      {
        schema: { params: applicationParams, body: resubmitBody },
        preHandler: [authenticateCustomer, app.csrfProtection],
      },
      async (request, reply) => {
        const actor = requireCustomerPrincipal(request);
        return reply.send(
          await approvals.resubmit({
            applicationId: request.params.applicationId,
            ...request.body,
            actor,
            requestId: request.id,
          }),
        );
      },
    );
  }
}
