import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  createStaffAuthenticationHook,
  requireStaffPrincipal,
} from "../../plugins/auth.js";
import type { AccessService } from "../access/service.js";
import type { AssetService } from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;
const idempotency = { type: "string", minLength: 8, maxLength: 128 } as const;
const vehicleParams = {
  type: "object",
  additionalProperties: false,
  required: ["vehicleUnitId"],
  properties: { vehicleUnitId: uuid },
} as const;
const applicationParams = {
  type: "object",
  additionalProperties: false,
  required: ["applicationId"],
  properties: { applicationId: uuid },
} as const;

export async function registerAssetRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  assets: AssetService,
): Promise<void> {
  const authenticateStaff = createStaffAuthenticationHook(access, config);
  const mutation = [authenticateStaff, app.csrfProtection];

  app.get(
    "/v1/staff/assets",
    { preHandler: authenticateStaff },
    async (request, reply) => {
      return reply.send(
        await assets.listInventory(requireStaffPrincipal(request)),
      );
    },
  );

  app.post<{
    Body: {
      vehicleModelId: string;
      vin: string;
      chassisNumber: string;
      engineMotorIdentifier: string;
      condition: Record<string, unknown>;
      accessories: string[];
      trackerIdentifier?: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/assets",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "vehicleModelId",
            "vin",
            "chassisNumber",
            "engineMotorIdentifier",
            "condition",
            "accessories",
            "idempotencyKey",
          ],
          properties: {
            vehicleModelId: uuid,
            vin: { type: "string", minLength: 1, maxLength: 128 },
            chassisNumber: { type: "string", minLength: 1, maxLength: 128 },
            engineMotorIdentifier: {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
            condition: { type: "object" },
            accessories: {
              type: "array",
              items: { type: "string", minLength: 1, maxLength: 128 },
            },
            trackerIdentifier: { type: "string", minLength: 1, maxLength: 128 },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: mutation,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.code(201).send(
        await assets.registerVehicle({
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
      vehicleUnitId: string;
      expectedVehicleVersion: number;
      previousAssignmentId?: string;
      reassignmentApproval?: { approvalId: string };
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/asset-assignment",
    {
      schema: {
        params: applicationParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "vehicleUnitId",
            "expectedVehicleVersion",
            "idempotencyKey",
          ],
          properties: {
            vehicleUnitId: uuid,
            expectedVehicleVersion: { type: "integer", minimum: 1 },
            previousAssignmentId: uuid,
            reassignmentApproval: {
              type: "object",
              additionalProperties: false,
              required: ["approvalId"],
              properties: {
                approvalId: uuid,
              },
            },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: mutation,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.send(
        await assets.assignVehicle({
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
      previousAssignmentId: string;
      requestedVehicleUnitId: string;
      reason: string;
      effectiveUntil?: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/reassignment-requests",
    {
      schema: {
        params: applicationParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "previousAssignmentId",
            "requestedVehicleUnitId",
            "reason",
            "idempotencyKey",
          ],
          properties: {
            previousAssignmentId: uuid,
            requestedVehicleUnitId: uuid,
            reason: { type: "string", minLength: 1, maxLength: 4000 },
            effectiveUntil: {
              type: "string",
              pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: mutation,
    },
    async (request, reply) =>
      reply.code(201).send(
        await assets.requestReassignment({
          applicationId: request.params.applicationId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { approvalId: string };
    Body: { idempotencyKey: string };
  }>(
    "/v1/staff/reassignment-approvals/:approvalId/approve",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["approvalId"],
          properties: { approvalId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: ["idempotencyKey"],
          properties: { idempotencyKey: idempotency },
        },
      },
      preHandler: mutation,
    },
    async (request, reply) =>
      reply.send(
        await assets.approveReassignment({
          approvalId: request.params.approvalId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { vehicleUnitId: string };
    Body: {
      registrationNumber: string;
      validFrom: string;
      validTo: string;
      evidenceDocumentId?: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/assets/:vehicleUnitId/registration",
    {
      schema: {
        params: vehicleParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "registrationNumber",
            "validFrom",
            "validTo",
            "expectedVehicleVersion",
            "idempotencyKey",
          ],
          properties: {
            registrationNumber: {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
            validFrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            validTo: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            evidenceDocumentId: uuid,
            expectedVehicleVersion: { type: "integer", minimum: 1 },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: mutation,
    },
    async (request, reply) =>
      reply.send(
        await assets.recordRegistration({
          vehicleUnitId: request.params.vehicleUnitId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { vehicleUnitId: string };
    Body: {
      policyNumber: string;
      provider: string;
      validFrom: string;
      validTo: string;
      evidenceDocumentId?: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/assets/:vehicleUnitId/insurance",
    {
      schema: {
        params: vehicleParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "policyNumber",
            "provider",
            "validFrom",
            "validTo",
            "expectedVehicleVersion",
            "idempotencyKey",
          ],
          properties: {
            policyNumber: { type: "string", minLength: 1, maxLength: 128 },
            provider: { type: "string", minLength: 1, maxLength: 256 },
            validFrom: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            validTo: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            evidenceDocumentId: uuid,
            expectedVehicleVersion: { type: "integer", minimum: 1 },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: mutation,
    },
    async (request, reply) =>
      reply.send(
        await assets.recordInsurance({
          vehicleUnitId: request.params.vehicleUnitId,
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { vehicleUnitId: string };
    Body: {
      provider: string;
      providerDeviceId: string;
      deepLink: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/assets/:vehicleUnitId/tracker",
    {
      schema: {
        params: vehicleParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "provider",
            "providerDeviceId",
            "deepLink",
            "expectedVehicleVersion",
            "idempotencyKey",
          ],
          properties: {
            provider: { type: "string", minLength: 1 },
            providerDeviceId: { type: "string", minLength: 1 },
            deepLink: { type: "string", format: "uri" },
            expectedVehicleVersion: { type: "integer", minimum: 1 },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: mutation,
    },
    async (request, reply) => {
      const response = await assets.associateTracker({
        vehicleUnitId: request.params.vehicleUnitId,
        ...request.body,
        actor: requireStaffPrincipal(request),
        requestId: request.id,
      });
      return reply.send(response);
    },
  );

  app.get<{
    Params: { vehicleUnitId: string };
    Querystring: { purpose?: string };
  }>(
    "/v1/staff/assets/:vehicleUnitId/tracker",
    {
      schema: {
        params: vehicleParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            purpose: { type: "string", minLength: 1, maxLength: 4000 },
          },
        },
      },
      preHandler: authenticateStaff,
    },
    async (request, reply) =>
      reply.send(
        await assets.getTrackerAccess({
          vehicleUnitId: request.params.vehicleUnitId,
          purpose: request.query.purpose ?? "AUTHORIZED_RECOVERY_REVIEW",
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
}
