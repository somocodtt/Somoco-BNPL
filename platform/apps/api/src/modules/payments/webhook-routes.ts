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
import type { LedgerService } from "./ledger-service.js";
import type { ReconciliationService } from "./reconciliation-service.js";
import type { ReceiptService } from "./receipt-service.js";
import type { PaymentWebhookService } from "./webhook-service.js";
import { AppError } from "../../plugins/errors.js";

declare module "fastify" {
  interface FastifyRequest {
    paymentRawBody?: Uint8Array;
  }
}

export interface PaymentRouteComposition {
  webhook: PaymentWebhookService;
  ledger: LedgerService;
  reconciliation: ReconciliationService;
  receipts: ReceiptService;
  ussdInstructions: string;
}

export async function registerPaymentRawBodyParser(
  app: FastifyInstance,
): Promise<void> {
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (request, body, done) => {
      const raw = new Uint8Array(body as Uint8Array);
      request.paymentRawBody = raw as unknown as Uint8Array;
      if (request.url.split("?", 1)[0] === "/v1/integrations/payments/somoco") {
        done(null, raw);
        return;
      }
      try {
        done(null, JSON.parse(new TextDecoder().decode(raw)) as unknown);
      } catch {
        const error = new AppError(
          400,
          "MALFORMED_JSON",
          "The payment event body is malformed.",
        );
        done(error);
      }
    },
  );
}

export async function registerPaymentRoutes(
  app: FastifyInstance,
  config: AppConfig,
  access: AccessService,
  composition: PaymentRouteComposition,
  customerOtp?: Pick<OtpService, "authenticateSessionToken">,
): Promise<void> {
  app.post(
    "/v1/integrations/payments/somoco",
    {
      schema: {
        headers: {
          type: "object",
          additionalProperties: true,
          required: ["x-payment-signature", "x-payment-timestamp"],
          properties: {
            "x-payment-signature": {
              type: "string",
              minLength: 1,
              maxLength: 512,
            },
            "x-payment-timestamp": {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
          },
        },
      },
    },
    async (request, reply) => {
      const rawBody = request.paymentRawBody;
      if (rawBody === undefined) {
        return reply.code(400).send({ code: "RAW_PAYMENT_BODY_REQUIRED" });
      }
      const signature = request.headers["x-payment-signature"];
      const requestTimestamp = request.headers["x-payment-timestamp"];
      if (
        typeof signature !== "string" ||
        typeof requestTimestamp !== "string"
      ) {
        return reply.code(400).send({ code: "PAYMENT_HEADERS_REQUIRED" });
      }
      const result = await composition.webhook.receive({
        rawBody,
        signature,
        requestTimestamp,
        validateJson: true,
      });
      return reply.code(202).send(result);
    },
  );

  if (customerOtp !== undefined) {
    const authenticateCustomer = createCustomerAuthenticationHook(customerOtp);
    app.get(
      "/v1/customer/payments",
      { preHandler: authenticateCustomer },
      async (request, reply) =>
        reply.send(
          await composition.receipts.listCustomerPayments(
            requireCustomerPrincipal(request),
          ),
        ),
    );
    app.get(
      "/v1/customer/payment-accounts",
      { preHandler: authenticateCustomer },
      async (request, reply) =>
        reply.send(
          await composition.receipts.listCustomerAccounts(
            requireCustomerPrincipal(request),
          ),
        ),
    );
    app.get(
      "/v1/customer/receipts",
      { preHandler: authenticateCustomer },
      async (request, reply) =>
        reply.send(
          await composition.receipts.listCustomerReceipts(
            requireCustomerPrincipal(request),
          ),
        ),
    );
    app.get<{
      Params: { receiptId: string };
    }>(
      "/v1/customer/receipts/:receiptId",
      {
        preHandler: authenticateCustomer,
        schema: {
          params: {
            type: "object",
            additionalProperties: false,
            required: ["receiptId"],
            properties: { receiptId: { type: "string", pattern: uuidPattern } },
          },
        },
      },
      async (request, reply) => {
        const receipt = await composition.receipts.getCustomerReceipt(
          requireCustomerPrincipal(request),
          request.params.receiptId,
        );
        if (receipt === null)
          throw new AppError(404, "RECEIPT_NOT_FOUND", "Receipt not found.");
        return reply.send(receipt);
      },
    );
    app.get(
      "/v1/customer/payment-instructions",
      { preHandler: authenticateCustomer },
      async (_request, reply) =>
        reply.send({
          channel: "USSD_MOBILE_MONEY",
          ussdInstructions: composition.ussdInstructions,
          cashAccepted: false,
        }),
    );
  }

  const authenticateStaff = createStaffAuthenticationHook(access, config);
  const staffRead = [authenticateStaff];
  const staffMutation = [authenticateStaff, app.csrfProtection];
  app.get(
    "/v1/staff/payments/inbox",
    { preHandler: staffRead },
    async (request, reply) => {
      assertFinanceRead(requireStaffPrincipal(request));
      return reply.send(await composition.reconciliation.listInbox());
    },
  );
  app.post<{
    Params: { caseId: string };
    Body: { resolution: Record<string, unknown> };
  }>(
    "/v1/staff/payments/reconciliation/:caseId/resolve",
    { preHandler: staffMutation, schema: reconciliationResolutionSchema },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      assertFinanceRead(actor);
      await composition.reconciliation.resolveCase({
        caseId: request.params.caseId,
        actor,
        resolution: request.body.resolution,
      });
      return reply.code(204).send();
    },
  );
  app.post<{
    Body: { settlementReference: string; providerTotalMinorUnits: string };
  }>(
    "/v1/staff/payments/settlements/compare",
    { preHandler: staffMutation, schema: settlementComparisonSchema },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      assertFinanceRead(actor);
      return reply.send(
        await composition.reconciliation.compareSettlement({
          settlementReference: request.body.settlementReference,
          provider: "SOMOCO_PAYMENTS",
          providerTotalMinorUnits: BigInt(request.body.providerTotalMinorUnits),
          actor,
        }),
      );
    },
  );
  app.get(
    "/v1/staff/payments/reconciliation",
    { preHandler: staffRead },
    async (request, reply) => {
      assertFinanceRead(requireStaffPrincipal(request));
      return reply.send(await composition.reconciliation.listCases());
    },
  );
  app.get(
    "/v1/staff/payments/settlements",
    { preHandler: staffRead },
    async (request, reply) => {
      assertFinanceRead(requireStaffPrincipal(request));
      return reply.send(await composition.reconciliation.listSettlements());
    },
  );
  app.get(
    "/v1/staff/payments/adjustments",
    { preHandler: staffRead },
    async (request, reply) => {
      assertFinanceRead(requireStaffPrincipal(request));
      return reply.send(await composition.reconciliation.listAdjustments());
    },
  );

  app.post<{
    Body: {
      contractId: string;
      amountMinorUnits: string;
      direction: "DEBIT" | "CREDIT";
      reason: string;
      idempotencyKey: string;
    };
  }>(
    "/v1/staff/payments/adjustments",
    { preHandler: staffMutation, schema: adjustmentRequestSchema },
    async (request, reply) => {
      const actor = requireStaffPrincipal(request);
      return reply.code(201).send(
        await composition.ledger.requestAdjustment({
          contractId: request.body.contractId,
          amountMinorUnits: BigInt(request.body.amountMinorUnits),
          direction: request.body.direction,
          reason: request.body.reason,
          maker: actor,
          idempotencyKey: request.body.idempotencyKey,
        }),
      );
    },
  );
  app.post<{
    Params: { adjustmentId: string };
    Body: { decision: "APPROVE" | "REJECT"; reason: string };
  }>(
    "/v1/staff/payments/adjustments/:adjustmentId/decision",
    { preHandler: staffMutation, schema: adjustmentDecisionSchema },
    async (request, reply) =>
      reply.send(
        await composition.ledger.approveAdjustment({
          adjustmentId: request.params.adjustmentId,
          checker: requireStaffPrincipal(request),
          decision: request.body.decision,
          reason: request.body.reason,
        }),
      ),
  );
}

function assertFinanceRead(
  actor: ReturnType<typeof requireStaffPrincipal>,
): void {
  if (
    !actor.roles.some((role) =>
      ["FINANCE_OFFICER", "CFO", "COMPLIANCE_AUDITOR", "MD"].includes(role),
    )
  )
    throw new AppError(403, "FORBIDDEN", "Finance access is required.");
}

const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$";
const adjustmentRequestSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: [
      "contractId",
      "amountMinorUnits",
      "direction",
      "reason",
      "idempotencyKey",
    ],
    properties: {
      contractId: { type: "string", pattern: uuidPattern },
      amountMinorUnits: {
        type: "string",
        pattern: "^[1-9][0-9]*$",
        maxLength: 20,
      },
      direction: { type: "string", enum: ["DEBIT", "CREDIT"] },
      reason: { type: "string", minLength: 1, maxLength: 500 },
      idempotencyKey: { type: "string", minLength: 1, maxLength: 200 },
    },
  },
} as const;
const adjustmentDecisionSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["adjustmentId"],
    properties: { adjustmentId: { type: "string", pattern: uuidPattern } },
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["decision", "reason"],
    properties: {
      decision: { type: "string", enum: ["APPROVE", "REJECT"] },
      reason: { type: "string", minLength: 1, maxLength: 500 },
    },
  },
} as const;
const reconciliationResolutionSchema = {
  params: {
    type: "object",
    additionalProperties: false,
    required: ["caseId"],
    properties: { caseId: { type: "string", pattern: uuidPattern } },
  },
  body: {
    type: "object",
    additionalProperties: false,
    required: ["resolution"],
    properties: {
      resolution: { type: "object", additionalProperties: true },
    },
  },
} as const;
const settlementComparisonSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    required: ["settlementReference", "providerTotalMinorUnits"],
    properties: {
      settlementReference: { type: "string", minLength: 1, maxLength: 128 },
      providerTotalMinorUnits: {
        type: "string",
        pattern: "^(0|[1-9][0-9]*)$",
        maxLength: 20,
      },
    },
  },
} as const;
