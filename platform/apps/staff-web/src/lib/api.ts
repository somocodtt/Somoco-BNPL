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
    return (await this.request("/v1/staff/products/rule-versions")) as ProductRuleSummary[];
  }

  async listExceptions(): Promise<StaffExceptionSummary[]> {
    return (await this.request("/v1/staff/exceptions")) as StaffExceptionSummary[];
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
