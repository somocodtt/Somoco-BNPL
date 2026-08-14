import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  createStaffAuthenticationHook,
  requireStaffPrincipal,
} from "../../plugins/auth.js";
import type { StaffRole } from "./policy.js";
import type { AccessService } from "./service.js";

const staffRoles = [
  "VERIFICATION_OFFICER",
  "BSM",
  "AGM",
  "CFO",
  "MD",
  "PRODUCT_ADMIN",
  "INVENTORY_OFFICER",
  "FINANCE_OFFICER",
  "RECOVERY_OFFICER",
  "COMPLIANCE_AUDITOR",
  "CUSTOMER_SUPPORT",
  "SYSTEM_ADMIN",
] as const satisfies readonly StaffRole[];

const sessionBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password", "mfaAssertion"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 254 },
    password: { type: "string", minLength: 12, maxLength: 256 },
    mfaAssertion: { type: "string", minLength: 1, maxLength: 4_096 },
  },
} as const;

const rolesSchema = {
  type: "array",
  minItems: 1,
  maxItems: staffRoles.length,
  uniqueItems: true,
  items: { type: "string", enum: staffRoles },
} as const;

const createUserBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["email", "password", "roles"],
  properties: {
    email: { type: "string", minLength: 3, maxLength: 256 },
    password: { type: "string", minLength: 12, maxLength: 256 },
    roles: rolesSchema,
  },
} as const;

const updateUserBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["expectedVersion"],
  anyOf: [{ required: ["status"] }, { required: ["roles"] }],
  properties: {
    expectedVersion: { type: "integer", minimum: 1 },
    status: { type: "string", enum: ["ACTIVE", "DISABLED", "LOCKED"] },
    roles: rolesSchema,
  },
} as const;

export async function registerAccessRoutes(
  app: FastifyInstance,
  config: AppConfig,
  service: AccessService,
): Promise<void> {
  const authenticateStaff = createStaffAuthenticationHook(service, config);
  const mutationPreHandlers = [authenticateStaff, app.csrfProtection];

  app.post<{
    Body: { email: string; password: string; mfaAssertion: string };
  }>(
    "/v1/staff/sessions",
    {
      schema: { body: sessionBodySchema },
      config: {
        rateLimit: {
          max: config.rateLimitMax,
          timeWindow: config.rateLimitWindowMs,
        },
      },
    },
    async (request, reply) => {
      const session = await service.createSession({
        ...request.body,
        requestId: request.id,
      });
      void reply.setCookie(config.cookieName, session.token, {
        expires: session.expiresAt,
        httpOnly: true,
        path: "/v1/staff",
        sameSite: "strict",
        secure: config.cookieSecure,
        signed: true,
      });
      const csrfToken = reply.generateCsrf();
      return reply.code(201).send({
        staffUserId: session.principal.staffUserId,
        roles: session.principal.roles,
        expiresAt: session.expiresAt.toISOString(),
        csrfToken,
      });
    },
  );

  app.delete(
    "/v1/staff/sessions/current",
    { preHandler: mutationPreHandlers },
    async (request, reply) => {
      const principal = requireStaffPrincipal(request);
      await service.revokeSession(principal, request.id);
      void reply.clearCookie(config.cookieName, {
        httpOnly: true,
        path: "/v1/staff",
        sameSite: "strict",
        secure: config.cookieSecure,
      });
      return reply.code(204).send();
    },
  );

  app.post<{
    Body: { email: string; password: string; roles: StaffRole[] };
  }>(
    "/v1/staff/users",
    { schema: { body: createUserBodySchema }, preHandler: mutationPreHandlers },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      await service.authorizePrivileged({
        principal: actor,
        action: "staff_user.create",
        requestId: request.id,
      });
      const created = await service.createUser({
        actor,
        ...request.body,
        requestId: request.id,
      });
      return reply.code(201).send(publicStaffUser(created));
    },
  );

  app.patch<{
    Params: { staffUserId: string };
    Body: {
      expectedVersion: number;
      status?: "ACTIVE" | "DISABLED" | "LOCKED";
      roles?: StaffRole[];
    };
  }>(
    "/v1/staff/users/:staffUserId",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["staffUserId"],
          properties: { staffUserId: { type: "string", format: "uuid" } },
        },
        body: updateUserBodySchema,
      },
      preHandler: mutationPreHandlers,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      await service.authorizePrivileged({
        principal: actor,
        action: "staff_user.update",
        requestId: request.id,
        targetId: request.params.staffUserId,
      });
      const updated = await service.updateUser({
        actor,
        staffUserId: request.params.staffUserId,
        expectedVersion: request.body.expectedVersion,
        ...(request.body.status === undefined
          ? {}
          : { status: request.body.status }),
        ...(request.body.roles === undefined
          ? {}
          : { roles: request.body.roles }),
        requestId: request.id,
      });
      return reply.send(publicStaffUser(updated));
    },
  );
}

function publicStaffUser(user: {
  id: string;
  email: string;
  status: string;
  version: number;
  roles: readonly string[];
}) {
  return {
    id: user.id,
    email: user.email,
    status: user.status,
    version: user.version,
    roles: user.roles,
  };
}
