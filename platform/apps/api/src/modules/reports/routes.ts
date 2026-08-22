import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  createStaffAuthenticationHook,
  requireStaffPrincipal,
} from "../../plugins/auth.js";
import type { AccessService } from "../access/service.js";
import type { ReportFormat, ReportName, ReportService } from "./service.js";

const reportNames = ["operations", "portfolio", "audit", "migration"] as const;
const uuid = { type: "string", format: "uuid" } as const;

export async function registerReportRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  reports: ReportService,
): Promise<void> {
  const authenticate = createStaffAuthenticationHook(access, config);
  const mutation = [authenticate, app.csrfProtection];
  for (const name of reportNames) {
    app.get<{
      Querystring: {
        status?: string;
        asOfDate?: string;
        includePersonalData?: string;
      };
    }>(
      `/v1/staff/reports/${name}`,
      {
        preHandler: authenticate,
        schema: {
          querystring: {
            type: "object",
            additionalProperties: false,
            properties: {
              status: { type: "string", maxLength: 64 },
              asOfDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
              includePersonalData: { type: "string", enum: ["true", "false"] },
            },
          },
        },
      },
      async (request, reply) => {
        const actor = requireStaffPrincipal(request);
        const filters = {
          ...(request.query.status === undefined
            ? {}
            : { status: request.query.status }),
          ...(request.query.asOfDate === undefined
            ? {}
            : { asOfDate: request.query.asOfDate }),
          ...(request.query.includePersonalData === "true"
            ? { includePersonalData: true }
            : {}),
        };
        const result = await reports[name]({ actor, filters });
        return reply.send(result);
      },
    );
  }

  app.post<{
    Body: {
      report: ReportName;
      format: ReportFormat;
      filters?: Record<string, unknown>;
    };
  }>(
    "/v1/staff/reports/exports",
    {
      preHandler: mutation,
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["report", "format"],
          properties: {
            report: { type: "string", enum: [...reportNames] },
            format: { type: "string", enum: ["CSV", "JSON"] },
            filters: { type: "object", additionalProperties: true },
          },
        },
      },
    },
    async (request, reply) =>
      reply.code(201).send(
        await reports.export({
          actor: requireStaffPrincipal(request),
          requestId: request.id,
          ...request.body,
        }),
      ),
  );

  app.get<{ Params: { exportId: string } }>(
    "/v1/staff/reports/exports/:exportId",
    {
      preHandler: authenticate,
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["exportId"],
          properties: { exportId: uuid },
        },
      },
    },
    async (request, reply) => {
      const result = await reports.getExport({
        actor: requireStaffPrincipal(request),
        exportId: request.params.exportId,
      });
      return result === null
        ? reply.code(404).send({ code: "REPORT_EXPORT_NOT_FOUND" })
        : reply.send(result);
    },
  );
}
