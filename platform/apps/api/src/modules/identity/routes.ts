import type { FastifyInstance } from "fastify";
import type { AppConfig } from "../../config.js";
import {
  createCustomerAuthenticationHook,
  requireCustomerPrincipal,
} from "../../plugins/auth.js";
import type { ConsentService } from "./consent-service.js";
import type { IdentityService } from "./nia-service.js";
import type { OtpService } from "./otp-service.js";

const phoneSchema = {
  type: "string",
  pattern: "^\\+[1-9][0-9]{7,14}$",
} as const;

const otpRequestSchema = {
  type: "object",
  additionalProperties: false,
  required: ["phoneE164"],
  properties: { phoneE164: phoneSchema },
} as const;

const otpVerificationSchema = {
  type: "object",
  additionalProperties: false,
  required: ["phoneE164", "code"],
  properties: {
    phoneE164: phoneSchema,
    code: { type: "string", pattern: "^[0-9]{4,9}$" },
  },
} as const;

const consentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["purpose", "documentVersion", "phoneE164"],
  properties: {
    purpose: { type: "string", pattern: "^[A-Z][A-Z0-9_]{2,63}$" },
    documentVersion: {
      type: "string",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$",
    },
    phoneE164: phoneSchema,
  },
} as const;

const niaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["consentId", "ghanaCardNumber", "idempotencyKey"],
  properties: {
    consentId: { type: "string", format: "uuid" },
    ghanaCardNumber: { type: "string", pattern: "^GHA-[0-9]{9}-[0-9]$" },
    idempotencyKey: { type: "string", format: "uuid" },
  },
} as const;

export async function registerIdentityRoutes(
  app: FastifyInstance,
  config: AppConfig,
  services: {
    otp: OtpService;
    consent: ConsentService;
    nia?: IdentityService;
  },
): Promise<void> {
  const authenticateCustomer = createCustomerAuthenticationHook(services.otp);
  const rateLimit = {
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
  };

  app.post<{ Body: { phoneE164: string } }>(
    "/v1/customer/otp/requests",
    { schema: { body: otpRequestSchema }, config: { rateLimit } },
    async (request, reply) => {
      const result = await services.otp.request({
        phoneE164: request.body.phoneE164,
        requestId: request.id,
      });
      return reply.code(202).send(result);
    },
  );

  app.post<{ Body: { phoneE164: string; code: string } }>(
    "/v1/customer/otp/verifications",
    { schema: { body: otpVerificationSchema }, config: { rateLimit } },
    async (request, reply) => {
      const result = await services.otp.verify({
        phoneE164: request.body.phoneE164,
        code: request.body.code,
        requestId: request.id,
      });
      return reply.code(201).send(result);
    },
  );

  app.post<{
    Body: {
      purpose: string;
      documentVersion: string;
      phoneE164: string;
    };
  }>(
    "/v1/customer/consents",
    { schema: { body: consentSchema }, preHandler: authenticateCustomer },
    async (request, reply) => {
      const principal = requireCustomerPrincipal(request);
      const result = await services.consent.record({
        subjectPersonId: principal.personId,
        purpose: request.body.purpose,
        documentVersion: request.body.documentVersion,
        phoneE164: request.body.phoneE164,
        sessionId: principal.sessionId,
        ipAddress: request.ip,
        userAgent: request.headers["user-agent"] ?? "UNKNOWN",
        requestId: request.id,
      });
      return reply.code(201).send(result);
    },
  );

  if (services.nia !== undefined) {
    const nia = services.nia;
    app.post<{
      Body: {
        consentId: string;
        ghanaCardNumber: string;
        idempotencyKey: string;
      };
    }>(
      "/v1/customer/identity/ghana-card-verifications",
      { schema: { body: niaSchema }, preHandler: authenticateCustomer },
      async (request, reply) => {
        const principal = requireCustomerPrincipal(request);
        const result = await nia.verifyGhanaCard({
          subjectPersonId: principal.personId,
          consentId: request.body.consentId,
          ghanaCardNumber: request.body.ghanaCardNumber,
          idempotencyKey: request.body.idempotencyKey,
          sessionId: principal.sessionId,
          requestId: request.id,
        });
        return reply.code(201).send(result);
      },
    );
  }
}
