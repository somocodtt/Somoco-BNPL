export type StaffRole =
  | "VERIFICATION_OFFICER"
  | "BSM"
  | "AGM"
  | "CFO"
  | "MD"
  | "PRODUCT_ADMIN"
  | "INVENTORY_OFFICER"
  | "FINANCE_OFFICER"
  | "RECOVERY_OFFICER"
  | "COMPLIANCE_AUDITOR"
  | "CUSTOMER_SUPPORT"
  | "SYSTEM_ADMIN";

export interface StaffSession {
  staffUserId: string;
  roles: readonly StaffRole[];
  expiresAt?: string;
  csrfToken?: string;
}

export interface QueueApplication {
  id: string;
  status: string;
  version: number;
  submittedAt: string | null;
  snapshot: Record<string, unknown>;
}

export interface ApplicationDetail extends QueueApplication {
  decisions: Array<Record<string, unknown>>;
  underwriting: Array<Record<string, unknown>>;
}

export type DecisionAction = "APPROVE" | "REJECT" | "REQUEST_INFORMATION";

export interface DecisionInput {
  action: DecisionAction;
  stage: string;
  expectedVersion: number;
  note: string;
  idempotencyKey: string;
}

export interface StaffApi {
  getQueue(): Promise<QueueApplication[]>;
  getApplication(applicationId: string): Promise<ApplicationDetail>;
  decide(
    applicationId: string,
    input: DecisionInput,
  ): Promise<{
    status: string;
    version: number;
  }>;
  login?(input: {
    email: string;
    password: string;
    mfaAssertion: string;
  }): Promise<StaffSession>;
}

import type {
  ProductApi,
  ProductRuleSummary,
  StaffExceptionSummary,
} from "../features/products/product-workspace.js";

export class ProblemError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}

export class FetchStaffApi implements StaffApi, ProductApi {
  private csrfToken = "";

  constructor(
    private readonly baseUrl = "",
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
  ) {}

  async login(input: {
    email: string;
    password: string;
    mfaAssertion: string;
  }): Promise<StaffSession> {
    const response = await this.request("/v1/staff/sessions", {
      method: "POST",
      body: input,
    });
    const session = response as StaffSession;
    this.csrfToken = session.csrfToken ?? "";
    return session;
  }

  async getQueue(): Promise<QueueApplication[]> {
    return (await this.request(
      "/v1/staff/applications/queue",
    )) as QueueApplication[];
  }

  async getApplication(applicationId: string): Promise<ApplicationDetail> {
    return (await this.request(
      `/v1/staff/applications/${encodeURIComponent(applicationId)}`,
    )) as ApplicationDetail;
  }

  async decide(applicationId: string, input: DecisionInput) {
    const actionPath =
      input.action === "APPROVE"
        ? "approve"
        : input.action === "REJECT"
          ? "reject"
          : "request-information";
    return (await this.request(
      `/v1/staff/applications/${encodeURIComponent(applicationId)}/${actionPath}`,
      {
        method: "POST",
        body: {
          expectedVersion: input.expectedVersion,
          stage: input.stage,
          note: input.note,
          idempotencyKey: input.idempotencyKey,
        },
      },
    )) as { status: string; version: number };
  }

  async listRules(): Promise<ProductRuleSummary[]> {
    const body = await this.request("/v1/staff/products/rule-versions");
    if (!Array.isArray(body)) throw malformedStaff("MALFORMED_RULE_LIST");
    return body.map(mapRuleSummary);
  }

  async listExceptions(): Promise<StaffExceptionSummary[]> {
    const body = await this.request("/v1/staff/exceptions");
    if (!Array.isArray(body)) throw malformedStaff("MALFORMED_EXCEPTION_LIST");
    return body.map(mapExceptionSummary);
  }

  async publish(
    ruleId: string,
    input: { effectiveFrom: string; effectiveUntil?: string; idempotencyKey: string },
  ): Promise<void> {
    await this.request(`/v1/staff/products/rule-versions/${encodeURIComponent(ruleId)}/publish`, {
      method: "POST",
      body: input,
    });
  }

  async decideException(
    exceptionId: string,
    input: { expectedVersion: number; decision: "APPROVE" | "REJECT"; reason: string },
  ): Promise<void> {
    await this.request(`/v1/staff/exceptions/${encodeURIComponent(exceptionId)}/decide`, {
      method: "POST",
      body: { ...input, idempotencyKey: crypto.randomUUID() },
    });
  }

  private async request(
    path: string,
    options: { method?: string; body?: unknown } = {},
  ): Promise<unknown> {
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      method: options.method ?? "GET",
      credentials: "include",
      headers: {
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(options.method === undefined || options.method === "GET"
          ? {}
          : { "x-csrf-token": this.csrfToken }),
      },
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const problem = body as { code?: unknown; detail?: unknown } | null;
      throw new ProblemError(
        typeof problem?.code === "string" ? problem.code : "REQUEST_FAILED",
        response.status,
        typeof problem?.detail === "string"
          ? problem.detail
          : "Request failed.",
      );
    }
    return body;
  }
}

function mapRuleSummary(value: unknown): ProductRuleSummary {
  if (!isRecord(value)) throw malformedStaff("MALFORMED_RULE_LIST");
  const id = requiredString(value.id, "MALFORMED_RULE_LIST");
  const versionNumber = requiredInteger(value.versionNumber, "MALFORMED_RULE_LIST");
  const status = value.status === "DRAFT" || value.status === "PUBLISHED" ? value.status : malformedStaff("MALFORMED_RULE_LIST");
  const gate = value.gate === "OPEN" || value.gate === "CLOSED" ? value.gate : malformedStaff("MALFORMED_RULE_LIST");
  const requestedBy = value.requestedBy === null ? null : requiredString(value.requestedBy, "MALFORMED_RULE_LIST");
  const effectiveFrom = value.effectiveFrom === null ? null : requiredString(value.effectiveFrom, "MALFORMED_RULE_LIST");
  const effectiveUntil = value.effectiveUntil === undefined || value.effectiveUntil === null
    ? null
    : requiredString(value.effectiveUntil, "MALFORMED_RULE_LIST");
  const result: ProductRuleSummary = {
    id,
    versionNumber,
    status,
    requestedBy,
    effectiveFrom,
    gate,
    effectiveUntil,
  };
  if (typeof value.licencePermitted === "boolean") result.licencePermitted = value.licencePermitted;
  if (value.disclosureVersion !== undefined) {
    result.disclosureVersion = value.disclosureVersion === null
      ? null
      : requiredString(value.disclosureVersion, "MALFORMED_RULE_LIST");
  }
  return result;
}

function mapExceptionSummary(value: unknown): StaffExceptionSummary {
  if (!isRecord(value)) throw malformedStaff("MALFORMED_EXCEPTION_LIST");
  if (!("proposedValue" in value) || !("policyValue" in value)) {
    throw malformedStaff("MALFORMED_EXCEPTION_LIST");
  }
  const status = value.status === "PENDING" || value.status === "APPROVED" || value.status === "REJECTED"
    ? value.status
    : malformedStaff("MALFORMED_EXCEPTION_LIST");
  return {
    id: requiredString(value.id, "MALFORMED_EXCEPTION_LIST"),
    status,
    requestedBy: requiredString(value.requestedBy, "MALFORMED_EXCEPTION_LIST"),
    requiredApproverRole: requiredString(value.requiredApproverRole, "MALFORMED_EXCEPTION_LIST"),
    proposedValue: value.proposedValue,
    policyValue: value.policyValue,
    reason: requiredString(value.reason, "MALFORMED_EXCEPTION_LIST"),
    version: requiredInteger(value.version, "MALFORMED_EXCEPTION_LIST"),
  };
}

function malformedStaff(code: string): never {
  throw new ProblemError(code, 502, "The staff financing response is invalid.");
}

function requiredString(value: unknown, code = "MALFORMED_FINANCING_DTO"): string {
  if (typeof value !== "string" || value.trim().length === 0) return malformedStaff(code);
  return value;
}

function requiredInteger(value: unknown, code = "MALFORMED_FINANCING_DTO"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) return malformedStaff(code);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
