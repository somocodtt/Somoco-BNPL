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
import type { ExceptionService } from "./exception-service.js";
import type { OfferService } from "./offer-service.js";
import type { ProductService } from "./service.js";

const uuid = { type: "string", format: "uuid" } as const;
const idempotency = { type: "string", minLength: 8, maxLength: 128 } as const;
const applicationParams = {
  type: "object",
  additionalProperties: false,
  required: ["applicationId"],
  properties: { applicationId: uuid },
} as const;
const ruleParams = {
  type: "object",
  additionalProperties: false,
  required: ["ruleId"],
  properties: { ruleId: uuid },
} as const;
const exceptionParams = {
  type: "object",
  additionalProperties: false,
  required: ["exceptionId"],
  properties: { exceptionId: uuid },
} as const;
const offerParams = {
  type: "object",
  additionalProperties: false,
  required: ["offerId"],
  properties: { offerId: uuid },
} as const;

export async function registerProductRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  products: ProductService,
  exceptions: ExceptionService,
  offers: OfferService,
  otp?: Pick<OtpService, "authenticateSessionToken">,
): Promise<void> {
  const authenticateStaff = createStaffAuthenticationHook(access, config);
  const staffMutation = [authenticateStaff, app.csrfProtection];
  app.post<{
    Params: { productId: string };
    Body: {
      versionNumber: number;
      sellingPriceMinor: string;
      minimumDepositMinor: string;
      method: "FLAT_MARKUP" | "REDUCING_BALANCE";
      rateBasisPoints: number;
      allowedTenuresMonths: number[];
      repaymentFrequencies: Array<"WEEKLY" | "MONTHLY">;
      permittedFees?: Record<string, unknown>;
      eligibilityPolicy?: Record<string, unknown>;
      requiredEvidence?: string[];
      exceptionPolicy?: Record<string, unknown>;
      disclosureVersion?: string;
      fixtureHashes?: string[];
      licencePermitted?: boolean;
    };
  }>(
    "/v1/staff/products/:productId/rule-versions",
    {
      schema: {
        params: {
          type: "object",
          additionalProperties: false,
          required: ["productId"],
          properties: { productId: uuid },
        },
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "versionNumber",
            "sellingPriceMinor",
            "minimumDepositMinor",
            "method",
            "rateBasisPoints",
            "allowedTenuresMonths",
            "repaymentFrequencies",
          ],
          properties: {
            versionNumber: { type: "integer", minimum: 1 },
            sellingPriceMinor: { type: "string", pattern: "^[0-9]+$" },
            minimumDepositMinor: { type: "string", pattern: "^[0-9]+$" },
            method: { type: "string", enum: ["FLAT_MARKUP", "REDUCING_BALANCE"] },
            rateBasisPoints: { type: "integer", minimum: 0 },
            allowedTenuresMonths: { type: "array", minItems: 1, items: { type: "integer" } },
            repaymentFrequencies: { type: "array", minItems: 1, items: { type: "string", enum: ["WEEKLY", "MONTHLY"] } },
            permittedFees: { type: "object" },
            eligibilityPolicy: { type: "object" },
            requiredEvidence: { type: "array", items: { type: "string" } },
            exceptionPolicy: { type: "object" },
            disclosureVersion: { type: "string", minLength: 1, maxLength: 128 },
            fixtureHashes: { type: "array", items: { type: "string", pattern: "^[0-9a-f]{64}$" } },
            licencePermitted: { type: "boolean" },
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      const created = await products.createRuleVersion({
        ...request.body,
        productId: request.params.productId,
        actor,
        requestId: request.id,
      });
      return reply.code(201).send(created);
    },
  );

  app.post<{
    Params: { ruleId: string };
    Body: { effectiveFrom: string; effectiveUntil?: string; idempotencyKey: string };
  }>(
    "/v1/staff/products/rule-versions/:ruleId/publish",
    {
      schema: {
        params: ruleParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["effectiveFrom", "idempotencyKey"],
          properties: {
            effectiveFrom: { type: "string", format: "date-time" },
            effectiveUntil: { type: "string", format: "date-time" },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) =>
      reply.send(
        await products.publishRuleVersion({
          ...request.body,
          ruleId: request.params.ruleId,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { applicationId: string };
    Body: {
      proposedValue: unknown;
      policyValue: unknown;
      reason: string;
      requiredApproverRole: Parameters<ExceptionService["request"]>[0]["requiredApproverRole"];
      expiresAt?: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/applications/:applicationId/exceptions",
    {
      schema: {
        params: applicationParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["proposedValue", "policyValue", "reason", "requiredApproverRole", "idempotencyKey"],
          properties: {
            proposedValue: {},
            policyValue: {},
            reason: { type: "string", minLength: 1, maxLength: 4_000 },
            requiredApproverRole: { type: "string", enum: ["PRODUCT_ADMIN", "BSM", "AGM", "CFO", "MD", "COMPLIANCE_AUDITOR"] },
            expiresAt: { type: "string", format: "date-time" },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) =>
      reply.code(201).send(
        await exceptions.request({
          ...request.body,
          applicationId: request.params.applicationId,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  app.post<{
    Params: { exceptionId: string };
    Body: { expectedVersion: number; decision: "APPROVE" | "REJECT"; reason: string; idempotencyKey: string };
  }>(
    "/v1/staff/exceptions/:exceptionId/decide",
    {
      schema: {
        params: exceptionParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", "decision", "reason", "idempotencyKey"],
          properties: {
            expectedVersion: { type: "integer", minimum: 1 },
            decision: { type: "string", enum: ["APPROVE", "REJECT"] },
            reason: { type: "string", minLength: 1, maxLength: 4_000 },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: staffMutation,
    },
    async (request, reply) =>
      reply.send(
        await exceptions.decide({
          ...request.body,
          exceptionId: request.params.exceptionId,
          actor: requireStaffPrincipal(request),
          requestId: request.id,
        }),
      ),
  );

  if (otp === undefined) return;
  const authenticateCustomer = createCustomerAuthenticationHook(otp);
  const customerMutation = [authenticateCustomer, app.csrfProtection];
  app.get<{ Params: { applicationId: string } }>(
    "/v1/customer/applications/:applicationId/offer",
    { schema: { params: applicationParams }, preHandler: authenticateCustomer },
    async (request, reply) => {
      const offer = await offers.getForCustomer(
        request.params.applicationId,
        requireCustomerPrincipal(request),
      );
      return reply.send(offer);
    },
  );
  app.post<{
    Params: { applicationId: string };
    Body: {
      depositMinor: string;
      frequency: "WEEKLY" | "MONTHLY";
      tenureMonths: 6 | 8 | 12 | 24 | 36 | 48;
      firstDueDate: string;
      expiresAt: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/customer/applications/:applicationId/offers",
    {
      schema: {
        params: applicationParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["depositMinor", "frequency", "tenureMonths", "firstDueDate", "expiresAt", "idempotencyKey"],
          properties: {
            depositMinor: { type: "string", pattern: "^[0-9]+$" },
            frequency: { type: "string", enum: ["WEEKLY", "MONTHLY"] },
            tenureMonths: { type: "integer", enum: [6, 8, 12, 24, 36, 48] },
            firstDueDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
            expiresAt: { type: "string", format: "date-time" },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: customerMutation,
    },
    async (request, reply) =>
      reply.code(201).send(
        await offers.create({
          ...request.body,
          applicationId: request.params.applicationId,
          actor: requireCustomerPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
  app.post<{
    Params: { offerId: string };
    Body: { expectedVersion: number; consentAt: string; idempotencyKey: string };
  }>(
    "/v1/customer/offers/:offerId/accept",
    {
      schema: {
        params: offerParams,
        body: {
          type: "object",
          additionalProperties: false,
          required: ["expectedVersion", "consentAt", "idempotencyKey"],
          properties: {
            expectedVersion: { type: "integer", minimum: 1 },
            consentAt: { type: "string", format: "date-time" },
            idempotencyKey: idempotency,
          },
        },
      },
      preHandler: customerMutation,
    },
    async (request, reply) =>
      reply.send(
        await offers.accept({
          ...request.body,
          offerId: request.params.offerId,
          actor: requireCustomerPrincipal(request),
          requestId: request.id,
        }),
      ),
  );
}
