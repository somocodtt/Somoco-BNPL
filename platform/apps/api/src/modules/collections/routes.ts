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
import type { CollectionsService } from "./service.js";
import type {
  NotificationService,
  ReminderTemplate,
} from "../notifications/service.js";
import type { SettlementService } from "../contracts/settlement-service.js";

const uuid = { type: "string", format: "uuid" } as const;
const idempotency = { type: "string", minLength: 8, maxLength: 200 } as const;
const contractParams = {
  type: "object",
  additionalProperties: false,
  required: ["contractId"],
  properties: { contractId: uuid },
} as const;
const recoveryCaseParams = {
  type: "object",
  additionalProperties: false,
  required: ["recoveryCaseId"],
  properties: { recoveryCaseId: uuid },
} as const;

export async function registerCollectionsRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  collections: CollectionsService,
  settlement: SettlementService,
  notifications?: NotificationService,
  customerOtp?: Pick<OtpService, "authenticateSessionToken">,
): Promise<void> {
  const authenticateStaff = createStaffAuthenticationHook(access, config);
  const mutation = [authenticateStaff, app.csrfProtection];
  app.get(
    "/v1/staff/collections/arrears",
    { preHandler: authenticateStaff },
    async (request, reply) =>
      reply.send(await collections.listArrears(requireStaffPrincipal(request))),
  );
  app.get(
    "/v1/staff/collections/cases",
    { preHandler: authenticateStaff },
    async (request, reply) =>
      reply.send(await collections.listCases(requireStaffPrincipal(request))),
  );
  app.post<{
    Body: {
      contractId: string;
      purpose: string;
      reason: string;
      assignedOfficerId?: string;
    };
  }>(
    "/v1/staff/collections/cases",
    {
      preHandler: mutation,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["contractId", "purpose", "reason"],
          properties: {
            contractId: uuid,
            purpose: { type: "string", minLength: 1, maxLength: 4000 },
            reason: { type: "string", minLength: 1, maxLength: 4000 },
            assignedOfficerId: uuid,
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await collections.openCase({
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.post<{
    Params: { recoveryCaseId: string };
    Body: {
      decision: "APPROVED" | "DENIED";
      purpose: string;
      reason: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/collections/cases/:recoveryCaseId/decision",
    {
      preHandler: mutation,
      schema: {
        params: recoveryCaseParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["decision", "purpose", "reason", "idempotencyKey"],
          properties: {
            decision: { type: "string", enum: ["APPROVED", "DENIED"] },
            purpose: { type: "string", minLength: 1, maxLength: 4000 },
            reason: { type: "string", minLength: 1, maxLength: 4000 },
            idempotencyKey: idempotency,
          },
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await collections.decideEscalation({
          recoveryCaseId: request.params.recoveryCaseId,
          ...request.body,
          checker: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.post<{
    Params: { recoveryCaseId: string };
    Body: {
      actionType:
        "MANUAL_RECOVERY" | "SEIZURE_EVIDENCE" | "VISIT" | "PROMISE_TO_PAY";
      purpose: string;
      requestedBy: string;
      evidence: Record<string, unknown>;
      evidenceHash: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/collections/cases/:recoveryCaseId/actions",
    {
      preHandler: mutation,
      schema: {
        params: recoveryCaseParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "actionType",
            "purpose",
            "requestedBy",
            "evidence",
            "evidenceHash",
            "idempotencyKey",
          ],
          properties: {
            actionType: {
              type: "string",
              enum: [
                "MANUAL_RECOVERY",
                "SEIZURE_EVIDENCE",
                "VISIT",
                "PROMISE_TO_PAY",
              ],
            },
            purpose: { type: "string", minLength: 1, maxLength: 4000 },
            requestedBy: uuid,
            evidence: { type: "object" },
            evidenceHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            idempotencyKey: idempotency,
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await collections.recordAction({
          recoveryCaseId: request.params.recoveryCaseId,
          ...request.body,
          authorizedBy: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.get<{
    Params: { recoveryCaseId: string };
    Querystring: { purpose: string };
  }>(
    "/v1/staff/collections/cases/:recoveryCaseId/location",
    {
      preHandler: authenticateStaff,
      schema: {
        params: recoveryCaseParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          required: ["purpose"],
          properties: {
            purpose: { type: "string", minLength: 1, maxLength: 4000 },
          },
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await collections.getLocation({
          recoveryCaseId: request.params.recoveryCaseId,
          purpose: request.query.purpose,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  if (notifications !== undefined) {
    app.get(
      "/v1/staff/collections/notifications",
      { preHandler: authenticateStaff },
      async (request, reply) =>
        reply.send(
          await notifications.listStaffHistory(requireStaffPrincipal(request)),
        ),
    );
    app.post<{
      Body: {
        contractId: string;
        template: ReminderTemplate;
        idempotencyKey: string;
        dueDate?: string;
        overdueMinorUnits?: string;
        missedInstallments?: number;
        asOfDate: string;
      };
    }>(
      "/v1/staff/collections/reminders",
      {
        preHandler: mutation,
        schema: {
          body: {
            type: "object",
            additionalProperties: false,
            required: ["contractId", "template", "idempotencyKey", "asOfDate"],
            properties: {
              contractId: uuid,
              template: {
                type: "string",
                enum: ["PAYMENT_DUE", "PAYMENT_WARNING", "ARREARS_WARNING"],
              },
              idempotencyKey: idempotency,
              dueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              overdueMinorUnits: {
                type: "string",
                pattern: "^(0|[1-9][0-9]*)$",
              },
              missedInstallments: { type: "integer", minimum: 0 },
              asOfDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            },
          },
        },
      },
      async (request, reply) =>
        reply.code(201).send(
          await notifications.queueReminder({
            contractId: request.body.contractId,
            template: request.body.template,
            idempotencyKey: request.body.idempotencyKey,
            asOfDate: request.body.asOfDate,
            ...(request.body.dueDate === undefined
              ? {}
              : { dueDate: request.body.dueDate }),
            ...(request.body.overdueMinorUnits === undefined
              ? {}
              : { overdueMinorUnits: BigInt(request.body.overdueMinorUnits) }),
            ...(request.body.missedInstallments === undefined
              ? {}
              : { missedInstallments: request.body.missedInstallments }),
            actor: requireStaffPrincipal(request),
            requestId: request.id,
          }),
        ),
    );
  }

  app.post<{
    Params: { contractId: string };
    Body: { reason: string; idempotencyKey: string };
  }>(
    "/v1/staff/contracts/:contractId/settlement/finance-approval",
    {
      preHandler: mutation,
      schema: { params: contractParams, body: approvalBodySchema },
    },
    async (request, reply) =>
      reply.send(
        await settlement.approveFinance({
          contractId: request.params.contractId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.post<{
    Params: { contractId: string };
    Body: { reason: string; idempotencyKey: string };
  }>(
    "/v1/staff/contracts/:contractId/settlement/business-approval",
    {
      preHandler: mutation,
      schema: { params: contractParams, body: approvalBodySchema },
    },
    async (request, reply) =>
      reply.send(
        await settlement.approveBusiness({
          contractId: request.params.contractId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.post<{
    Params: { contractId: string };
    Body: {
      evidenceDocumentId: string;
    };
  }>(
    "/v1/staff/contracts/:contractId/settlement/evidence",
    {
      preHandler: mutation,
      schema: {
        params: contractParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["evidenceDocumentId"],
          properties: {
            evidenceDocumentId: uuid,
          },
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await settlement.recordEvidence({
          contractId: request.params.contractId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  for (const [path, method] of [
    ["/v1/staff/contracts/:contractId/settlement/commit", "settle"],
    ["/v1/staff/contracts/:contractId/ownership-transfer", "transferOwnership"],
  ] as const) {
    app.post<{ Params: { contractId: string } }>(
      path,
      { preHandler: mutation, schema: { params: contractParams } },
      async (request, reply) =>
        reply.send(
          await settlement[method]({
            contractId: request.params.contractId,
            actor: requireStaffPrincipal(request),
            requestId: request.id,
          }),
        ),
    );
  }

  if (customerOtp !== undefined) {
    const authenticateCustomer = createCustomerAuthenticationHook(customerOtp);
    app.get(
      "/v1/customer/account-status",
      { preHandler: authenticateCustomer },
      async (request, reply) =>
        reply.send(
          await collections.getCustomerStatus(
            requireCustomerPrincipal(request),
          ),
        ),
    );
    if (notifications !== undefined)
      app.get(
        "/v1/customer/reminders",
        { preHandler: authenticateCustomer },
        async (request, reply) =>
          reply.send(
            await notifications.listCustomerHistory(
              requireCustomerPrincipal(request),
            ),
          ),
      );
  }
}

const approvalBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["reason", "idempotencyKey"],
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 4000 },
    idempotencyKey: idempotency,
  },
} as const;
