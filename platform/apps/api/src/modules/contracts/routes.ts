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
import type { ContractService } from "./service.js";
import type { HandoverService } from "./handover-service.js";

const uuid = { type: "string", format: "uuid" } as const;
const idempotency = { type: "string", minLength: 8, maxLength: 128 } as const;
const contractParams = {
  type: "object",
  additionalProperties: false,
  required: ["contractId"],
  properties: { contractId: uuid },
} as const;
const applicationParams = {
  type: "object",
  additionalProperties: false,
  required: ["applicationId"],
  properties: { applicationId: uuid },
} as const;

export async function registerContractRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  contracts: ContractService,
  handover: HandoverService,
  otp?: Pick<OtpService, "authenticateSessionToken">,
): Promise<void> {
  const authenticateStaff = createStaffAuthenticationHook(access, config);
  const staffMutation = [authenticateStaff, app.csrfProtection];

  app.get<{ Params: { applicationId: string } }>(
    "/v1/staff/applications/:applicationId/contract",
    { schema: { params: applicationParams }, preHandler: authenticateStaff },
    async (request, reply) =>
      reply.send(
        await contracts.get(
          request.params.applicationId,
          requireStaffPrincipal(request),
        ),
      ),
  );

  app.post<{
    Params: { applicationId: string };
    Body: {
      assignmentId: string;
      templateVersionId?: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/contracts",
    {
      schema: {
        params: applicationParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["assignmentId", "idempotencyKey"],
          properties: {
            assignmentId: uuid,
            templateVersionId: uuid,
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) =>
      reply.code(201).send(
        await contracts.generate({
          applicationId: request.params.applicationId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { contractId: string };
    Body: {
      expectedVersion: number;
      applicantPersonId: string;
      guarantorPersonId: string;
      staffWitnessId: string;
      executionDate: string;
      headOfficeId: string;
      headOfficeLocation: string;
      executedDocumentId: string;
      executedDocumentHash: string;
      authorizationReason?: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/contracts/:contractId/execution",
    {
      schema: {
        params: contractParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "expectedVersion",
            "applicantPersonId",
            "guarantorPersonId",
            "staffWitnessId",
            "executionDate",
            "headOfficeId",
            "headOfficeLocation",
            "executedDocumentId",
            "executedDocumentHash",
            "idempotencyKey",
          ],
          properties: {
            expectedVersion: { type: "integer", minimum: 1 },
            applicantPersonId: uuid,
            guarantorPersonId: uuid,
            staffWitnessId: uuid,
            executionDate: { type: "string", format: "date-time" },
            headOfficeId: { type: "string", minLength: 1, maxLength: 256 },
            headOfficeLocation: {
              type: "string",
              minLength: 1,
              maxLength: 256,
            },
            executedDocumentId: uuid,
            executedDocumentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            authorizationReason: {
              type: "string",
              minLength: 1,
              maxLength: 4000,
            },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) =>
      reply.send(
        await contracts.recordPhysicalExecution({
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
      expectedVersion: number;
      checklistVersion: string;
      checklist: Record<string, unknown>;
      customerAcknowledged: boolean;
      customerAcknowledgementId: string;
      customerAcknowledgedByPersonId?: string;
      condition: { description: string; checkResult: string };
      accessories: { items: string[]; none?: boolean };
      headOfficeId: string;
      headOfficeLocation: string;
      handedOverAt: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/contracts/:contractId/handover",
    {
      schema: {
        params: contractParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "expectedVersion",
            "checklistVersion",
            "checklist",
            "customerAcknowledged",
            "customerAcknowledgementId",
            "condition",
            "accessories",
            "headOfficeLocation",
            "headOfficeId",
            "handedOverAt",
            "idempotencyKey",
          ],
          properties: {
            expectedVersion: { type: "integer", minimum: 1 },
            checklistVersion: { type: "string", minLength: 1, maxLength: 128 },
            checklist: { type: "object" },
            customerAcknowledged: { type: "boolean", const: true },
            customerAcknowledgementId: uuid,
            customerAcknowledgedByPersonId: uuid,
            condition: {
              type: "object",
              additionalProperties: false,
              required: ["description", "checkResult"],
              properties: {
                description: { type: "string", minLength: 1, maxLength: 4000 },
                checkResult: { type: "string", minLength: 1, maxLength: 128 },
              },
            },
            accessories: {
              type: "object",
              additionalProperties: false,
              required: ["items"],
              properties: {
                items: {
                  type: "array",
                  items: { type: "string", minLength: 1, maxLength: 256 },
                },
                none: { type: "boolean" },
              },
            },
            headOfficeLocation: {
              type: "string",
              minLength: 1,
              maxLength: 256,
            },
            headOfficeId: { type: "string", minLength: 1, maxLength: 256 },
            handedOverAt: { type: "string", format: "date-time" },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) =>
      reply.send(
        await handover.complete({
          contractId: request.params.contractId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { contractId: string };
    Body: { expectedVersion: number; idempotencyKey: string };
  }>(
    "/v1/staff/contracts/:contractId/activate",
    {
      schema: {
        params: contractParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", "idempotencyKey"],
          properties: {
            expectedVersion: { type: "integer", minimum: 1 },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) =>
      reply.send(
        await contracts.activate({
          contractId: request.params.contractId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  if (otp === undefined) return;
  const authenticateCustomer = createCustomerAuthenticationHook(otp);
  app.get<{ Params: { applicationId: string } }>(
    "/v1/customer/applications/:applicationId/contract",
    { schema: { params: applicationParams }, preHandler: authenticateCustomer },
    async (request, reply) =>
      reply.send(
        await contracts.getForCustomer(
          request.params.applicationId,
          requireCustomerPrincipal(request),
        ),
      ),
  );

  app.post<{
    Params: { contractId: string };
    Body: {
      checklistVersion: string;
      checklist: Record<string, unknown>;
      idempotencyKey: string;
    };
  }>(
    "/v1/customer/contracts/:contractId/handover-acknowledgement",
    {
      schema: {
        params: contractParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["checklistVersion", "checklist", "idempotencyKey"],
          properties: {
            checklistVersion: { type: "string", minLength: 1, maxLength: 128 },
            checklist: { type: "object" },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: authenticateCustomer,
    },
    async (request, reply) =>
      reply.code(201).send(
        await handover.acknowledge({
          contractId: request.params.contractId,
          ...request.body,
          actor: requireCustomerPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
}
