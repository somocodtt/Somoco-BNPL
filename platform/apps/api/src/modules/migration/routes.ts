import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  createStaffAuthenticationHook,
  requireStaffPrincipal,
} from "../../plugins/auth.js";
import type { AccessService } from "../access/service.js";
import type { StaffPrincipal } from "../access/policy.js";
import type { MigrationService } from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;
const batchParams = {
  type: "object",
  additionalProperties: false,
  required: ["batchId"],
  properties: { batchId: uuid },
} as const;
const hash = { type: "string", pattern: "^[0-9a-f]{64}$" } as const;

export async function registerMigrationRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  migration: MigrationService,
): Promise<void> {
  const authenticate = createStaffAuthenticationHook(access, config);
  const mutation = [authenticate, app.csrfProtection];
  app.get(
    "/v1/staff/migrations",
    { preHandler: authenticate },
    async (request, reply) =>
      reply.send(await migration.listBatches(requireStaffPrincipal(request))),
  );
  app.post<{
    Body: Parameters<MigrationService["importBatch"]>[0] extends infer T
      ? T extends { actor: StaffPrincipal; requestId: string }
        ? Omit<T, "actor" | "requestId">
        : never
      : never;
  }>(
    "/v1/staff/migrations/import",
    {
      preHandler: mutation,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "source",
            "sourceBatchId",
            "sourceFileHash",
            "templateVersion",
            "expectedRecords",
            "rows",
          ],
          properties: {
            source: {
              type: "string",
              enum: ["LEGACY_EXCEL", "LEGACY_CSV", "LEGACY_PAPER"],
            },
            sourceBatchId: { type: "string", minLength: 1, maxLength: 256 },
            sourceFileHash: hash,
            templateVersion: { type: "string", minLength: 1, maxLength: 128 },
            expectedRecords: { type: "integer", minimum: 0 },
            sampleRequired: { type: "integer", minimum: 1 },
            controlTotalMinorUnits: {
              type: "string",
              pattern: "^(0|[1-9][0-9]*)$",
            },
            rows: {
              type: "array",
              maxItems: 10000,
              items: { type: "object", additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await migration.importBatch({
          ...request.body,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.post<{ Params: { batchId: string } }>(
    "/v1/staff/migrations/:batchId/validate",
    { preHandler: mutation, schema: { params: batchParams } },
    async (request, reply) =>
      reply.send(
        await migration.validate({
          batchId: request.params.batchId,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.post<{
    Params: { batchId: string };
    Body: { sampleRecordIds?: string[] };
  }>(
    "/v1/staff/migrations/:batchId/verify",
    {
      preHandler: mutation,
      schema: {
        params: batchParams,
        body: {
          type: "object",
          additionalProperties: false,
          properties: {
            sampleRecordIds: { type: "array", items: uuid, uniqueItems: true },
          },
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await migration.verifyBatch({
          batchId: request.params.batchId,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
          ...(request.body.sampleRecordIds === undefined
            ? {}
            : { sampleRecordIds: request.body.sampleRecordIds }),
        }),
      ),
  );
  app.post<{
    Params: { batchId: string };
    Body: { financialEvidenceHash: string };
  }>(
    "/v1/staff/migrations/:batchId/approve",
    {
      preHandler: mutation,
      schema: {
        params: batchParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["financialEvidenceHash"],
          properties: { financialEvidenceHash: hash },
        },
      },
    },
    async (request, reply) =>
      reply.send(
        await migration.approveBatch({
          batchId: request.params.batchId,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
          financialEvidenceHash: request.body.financialEvidenceHash,
        }),
      ),
  );
  app.post<{ Params: { batchId: string } }>(
    "/v1/staff/migrations/:batchId/activate",
    { preHandler: mutation, schema: { params: batchParams } },
    async (request, reply) =>
      reply.send(
        await migration.activateBatch({
          batchId: request.params.batchId,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
}
