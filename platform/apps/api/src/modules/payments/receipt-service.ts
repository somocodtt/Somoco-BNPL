import { randomUUID } from "node:crypto";
import {
  enqueueOutbox,
  paymentRepo,
  withTransaction,
  type Database,
  type DatabaseTransaction,
  type PaymentReceipt,
  type PaymentTransaction,
} from "@somo/db";
import type { CustomerPrincipal } from "../access/policy.js";

export interface ReceiptService {
  issue(input: {
    payment: PaymentTransaction;
    now?: Date;
    transaction?: DatabaseTransaction;
  }): Promise<PaymentReceipt>;
  listCustomerPayments(
    actor: CustomerPrincipal,
  ): Promise<readonly Record<string, unknown>[]>;
  listCustomerReceipts(
    actor: CustomerPrincipal,
  ): Promise<readonly Record<string, unknown>[]>;
}

export function createReceiptService(options: {
  database: Database;
  accountLinkBaseUrl: string;
  ussdInstructions: string;
}): ReceiptService {
  const accountLinkBaseUrl = validateAccountLink(options.accountLinkBaseUrl);
  const ussdInstructions = options.ussdInstructions.trim();
  if (ussdInstructions.length === 0 || ussdInstructions.length > 240)
    throw new Error("PAYMENT_USSD_INSTRUCTIONS_INVALID");
  return {
    async issue(input) {
      const operation = async (
        tx: DatabaseTransaction,
      ): Promise<PaymentReceipt> => {
        const repo = paymentRepo(tx);
        const existing = await repo.findReceipt(input.payment.id);
        if (existing !== null) return existing;
        const issuedAt = input.now ?? new Date();
        const receipt = await repo.issueReceipt({
          id: randomUUID(),
          paymentTransactionId: input.payment.id,
          ...(input.payment.contractId === null
            ? {}
            : { contractId: input.payment.contractId }),
          receiptNumber: `SOMO-${input.payment.id.slice(0, 12).toUpperCase()}`,
          payerReference: input.payment.payerReference,
          amountMinorUnits: input.payment.amountMinorUnits,
          currency: input.payment.currency,
          issuedAt,
          securePath: `${accountLinkBaseUrl}/receipts/${encodeURIComponent(input.payment.id)}`,
        });
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "payments.receipt_sms_requested",
          aggregateType: "payment_receipt",
          aggregateId: receipt.id,
          payload: {
            paymentTransactionId: input.payment.id,
            receiptId: receipt.id,
            phoneE164: input.payment.payerReference,
            template: "PAYMENT_RECEIPT",
            variables: {
              receiptLink: `${accountLinkBaseUrl}/receipts/${encodeURIComponent(input.payment.id)}`,
              ussdInstructions,
            },
          },
          occurredAt: issuedAt,
        });
        return receipt;
      };
      return input.transaction === undefined
        ? withTransaction(options.database, operation)
        : operation(input.transaction);
    },
    async listCustomerPayments(actor) {
      return paymentRepoForRead(options.database, actor).listCustomerPayments();
    },
    async listCustomerReceipts(actor) {
      return paymentRepoForRead(options.database, actor).listCustomerReceipts();
    },
  };
}

function paymentRepoForRead(database: Database, actor: CustomerPrincipal) {
  return {
    async listCustomerPayments() {
      return withTransaction(database, async (tx) =>
        paymentRepo(tx).listCustomerPayments(actor.personId),
      );
    },
    async listCustomerReceipts() {
      return withTransaction(database, async (tx) =>
        paymentRepo(tx).listCustomerReceipts(actor.personId),
      );
    },
  };
}

function validateAccountLink(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.search !== "" || url.hash !== "")
    throw new Error("PAYMENT_ACCOUNT_LINK_INVALID");
  return url.toString().replace(/\/$/, "");
}
