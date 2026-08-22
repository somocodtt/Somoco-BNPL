import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  collectionsRepo,
  enqueueOutbox,
  withTransaction,
  type Database,
} from "@somo/db";
import type { CustomerPrincipal, StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export type ReminderTemplate =
  "PAYMENT_DUE" | "PAYMENT_WARNING" | "ARREARS_WARNING";

export interface NotificationService {
  queueReminder(input: {
    contractId: string;
    template: ReminderTemplate;
    idempotencyKey: string;
    dueDate?: string;
    overdueMinorUnits?: bigint;
    missedInstallments?: number;
    asOfDate: string;
    actor: StaffPrincipal;
    requestId?: string;
  }): Promise<{ id: string; status: "QUEUED"; idempotencyKey: string }>;
  listCustomerHistory(
    actor: CustomerPrincipal,
  ): Promise<readonly Record<string, unknown>[]>;
  listStaffHistory(
    actor: StaffPrincipal,
  ): Promise<readonly Record<string, unknown>[]>;
}

export function createNotificationService(options: {
  database: Database;
  accountLinkBaseUrl: string;
  ussdInstructions: string;
}): NotificationService {
  const accountLinkBaseUrl = validateAccountLink(options.accountLinkBaseUrl);
  const ussdInstructions = validatePaymentInstructions(
    options.ussdInstructions,
  );
  return {
    async queueReminder(input) {
      if (!hasCollectionsMutation(input.actor)) {
        await withTransaction(options.database, async (tx) => {
          await appendAuditEvent(tx, {
            aggregateType: "contract",
            aggregateId: input.contractId,
            action: "REMINDER_DENIED",
            actorStaffUserId: input.actor.staffUserId,
            actorPersonId: null,
            requestId: input.requestId ?? null,
            data: { reason: "COLLECTIONS_ROLE_REQUIRED" },
            occurredAt: new Date(),
          });
        });
        throw new AppError(
          403,
          "FORBIDDEN",
          "Collections reminder authority is required.",
        );
      }
      validateIdempotencyKey(input.idempotencyKey);
      validateDate(input.asOfDate, "REMINDER_DATE_INVALID");
      if (input.dueDate !== undefined)
        validateDate(input.dueDate, "REMINDER_DUE_DATE_INVALID");
      if (
        (input.template === "PAYMENT_DUE" ||
          input.template === "PAYMENT_WARNING") &&
        input.dueDate === undefined
      )
        throw new AppError(
          400,
          "REMINDER_DUE_DATE_REQUIRED",
          "A due date is required for this reminder.",
        );
      if (
        input.template === "ARREARS_WARNING" &&
        input.overdueMinorUnits === undefined &&
        input.missedInstallments === undefined
      )
        throw new AppError(
          400,
          "REMINDER_ARREARS_CONTEXT_REQUIRED",
          "Arrears context is required for an arrears warning.",
        );
      if (input.overdueMinorUnits !== undefined && input.overdueMinorUnits < 0n)
        throw new AppError(
          400,
          "REMINDER_AMOUNT_INVALID",
          "Overdue amount cannot be negative.",
        );
      if (
        input.missedInstallments !== undefined &&
        (!Number.isSafeInteger(input.missedInstallments) ||
          input.missedInstallments < 0)
      )
        throw new AppError(
          400,
          "REMINDER_COUNT_INVALID",
          "Missed installment count is invalid.",
        );
      return withTransaction(options.database, async (tx) => {
        const repo = collectionsRepo(tx);
        const context = await repo.findContractContext(input.contractId);
        if (context === null)
          throw new AppError(
            404,
            "CONTRACT_NOT_FOUND",
            "The customer account was not found.",
          );
        if (context.status !== "ACTIVE" && context.status !== "RECOVERY")
          throw new AppError(
            409,
            "CONTRACT_NOT_ELIGIBLE",
            "Reminders can only be queued for an active customer account.",
          );
        const accountLink = `${accountLinkBaseUrl}/contracts/${encodeURIComponent(input.contractId)}/status`;
        const variables: Record<string, string> = {
          accountLink,
          ussdInstructions,
          cashPolicy: "Cash is not accepted.",
          asOfDate: input.asOfDate,
          ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
          ...(input.overdueMinorUnits === undefined
            ? {}
            : { overdueMinorUnits: input.overdueMinorUnits.toString() }),
          ...(input.missedInstallments === undefined
            ? {}
            : { missedInstallments: String(input.missedInstallments) }),
        };
        rejectSensitiveVariables(variables);
        const notificationResult = await repo.insertNotification({
          channel: "SMS",
          recipientReference: context.phoneE164,
          template: input.template,
          idempotencyKey: input.idempotencyKey,
          payload: {
            contractId: input.contractId,
            template: input.template,
            variables,
          },
          status: "QUEUED",
        });
        const inserted = notificationResult.row;
        if (!notificationResult.inserted) {
          const existingPayload = inserted.payload;
          const existingContractId =
            typeof existingPayload === "object" &&
            existingPayload !== null &&
            !Array.isArray(existingPayload)
              ? (existingPayload as Record<string, unknown>).contractId
              : undefined;
          if (
            existingContractId !== input.contractId ||
            inserted.template !== input.template
          )
            throw new AppError(
              409,
              "REMINDER_IDEMPOTENCY_KEY_REUSED",
              "The reminder idempotency key is already bound to another reminder.",
            );
          return {
            id: inserted.id,
            status: "QUEUED",
            idempotencyKey: inserted.idempotencyKey,
          };
        }
        const occurredAt = new Date();
        await enqueueOutbox(tx, {
          id: randomUUID(),
          topic: "collections.reminder_requested",
          aggregateType: "notification",
          aggregateId: inserted.id,
          payload: { notificationId: inserted.id },
          occurredAt,
        });
        await appendAuditEvent(tx, {
          aggregateType: "notification",
          aggregateId: inserted.id,
          action: "REMINDER_QUEUED",
          actorStaffUserId: input.actor.staffUserId,
          actorPersonId: context.applicantPersonId,
          requestId: input.requestId ?? null,
          data: {
            contractId: input.contractId,
            template: input.template,
            idempotencyKey: input.idempotencyKey,
            cashAccepted: false,
          },
          occurredAt,
        });
        return {
          id: inserted.id,
          status: "QUEUED",
          idempotencyKey: inserted.idempotencyKey,
        };
      });
    },
    async listCustomerHistory(actor) {
      return withTransaction(options.database, async (tx) => {
        const rows = await collectionsRepo(tx).listCustomerNotifications(
          actor.personId,
        );
        return rows.map((row) => ({
          id: row.id,
          template: row.template,
          status: row.status,
          createdAt: new Date(row.created_at).toISOString(),
          updatedAt: new Date(row.updated_at).toISOString(),
        }));
      });
    },
    async listStaffHistory(actor) {
      if (!hasCollectionsRead(actor))
        throw new AppError(403, "FORBIDDEN", "Collections access is required.");
      return withTransaction(options.database, async (tx) => {
        const rows = await collectionsRepo(tx).listNotifications();
        return rows.map((row) => ({
          id: row.id,
          template: row.template,
          status: row.status,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        }));
      });
    },
  };
}

function validateAccountLink(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("REMINDER_ACCOUNT_LINK_INVALID");
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  )
    throw new Error("REMINDER_ACCOUNT_LINK_INVALID");
  return url.toString().replace(/\/$/, "");
}

function validatePaymentInstructions(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 240)
    throw new Error("REMINDER_USSD_INSTRUCTIONS_INVALID");
  return trimmed;
}

function validateIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value))
    throw new AppError(
      400,
      "REMINDER_IDEMPOTENCY_INVALID",
      "A reminder idempotency key is required.",
    );
}

function validateDate(value: string, code: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null)
    throw new AppError(400, code, "A calendar date is required.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days)
    throw new AppError(400, code, "A calendar date is required.");
}

function rejectSensitiveVariables(variables: Record<string, string>): void {
  if (
    Object.keys(variables).some((key) =>
      /secret|token|otp|password|ghana.?card|latitude|longitude/i.test(key),
    )
  )
    throw new Error("REMINDER_SENSITIVE_DATA_FORBIDDEN");
}

function hasCollectionsRead(actor: StaffPrincipal): boolean {
  return actor.roles.some((role) =>
    [
      "RECOVERY_OFFICER",
      "BSM",
      "AGM",
      "CFO",
      "MD",
      "COMPLIANCE_AUDITOR",
      "CUSTOMER_SUPPORT",
    ].includes(role),
  );
}

function hasCollectionsMutation(actor: StaffPrincipal): boolean {
  return actor.roles.some((role) =>
    [
      "RECOVERY_OFFICER",
      "BSM",
      "AGM",
      "CFO",
      "MD",
      "COMPLIANCE_AUDITOR",
    ].includes(role),
  );
}
