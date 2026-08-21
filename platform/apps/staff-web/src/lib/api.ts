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

export interface StaffAssetSummary {
  id: string;
  vehicleModelId: string;
  vin: string;
  chassisNumber: string;
  engineMotorIdentifier: string | null;
  condition: Record<string, unknown>;
  accessories: readonly string[];
  trackerIdentifier: string | null;
  registrationNumber: string | null;
  status: string;
  version: number;
}

export interface StaffAssignmentSummary {
  id: string;
  applicationId: string;
  vehicleUnitId: string;
  offerId: string;
  offerVersionId: string;
  depositReconciledAmountMinor: string;
  depositEvidenceId: string;
  supersedesAssignmentId: string | null;
  assignedAt: string;
  version: number;
}

export interface StaffAssetApi {
  listInventory(): Promise<StaffAssetSummary[]>;
  assignVehicle(
    applicationId: string,
    input: {
      vehicleUnitId: string;
      expectedVehicleVersion: number;
      previousAssignmentId?: string;
      reassignmentApproval?: { approvedBy: string; reason: string };
      idempotencyKey: string;
    },
  ): Promise<StaffAssignmentSummary>;
}

export type StaffContractStatus =
  | "DRAFT"
  | "AWAITING_EXECUTION"
  | "EXECUTED"
  | "ACTIVE"
  | "SETTLED"
  | "RECOVERY"
  | "TERMINATED";

export interface StaffContractSummary {
  id: string;
  reference: string;
  applicationId: string;
  offerVersionId: string;
  vehicleUnitId: string;
  status: StaffContractStatus;
  version: number;
  canonicalHash: string;
  previewReference: string;
  ownershipHolder: "SOMOCO";
  outstandingBalanceMinor: string;
  generatedAt: string;
  activatedAt: string | null;
}

export interface StaffContractApi {
  get(applicationId: string): Promise<StaffContractSummary | null>;
  generate(
    applicationId: string,
    input: {
      assignmentId: string;
      templateVersionId?: string;
      idempotencyKey: string;
    },
  ): Promise<StaffContractSummary>;
  recordExecution(
    contractId: string,
    input: {
      expectedVersion: number;
      applicantSignature: string;
      guarantorSignature: string;
      staffWitnessId: string;
      executionDate: string;
      headOfficeLocation?: string;
      executedDocumentId: string;
      executedDocumentHash: string;
      authorizationReason?: string;
      idempotencyKey: string;
    },
  ): Promise<StaffContractSummary>;
  completeHandover(
    contractId: string,
    input: {
      expectedVersion: number;
      checklistVersion: string;
      checklist: Record<string, unknown>;
      customerAcknowledged: true;
      customerAcknowledgedByPersonId?: string;
      condition: Record<string, unknown>;
      accessories: readonly string[];
      headOfficeLocation: string;
      handedOverAt: string;
      idempotencyKey: string;
    },
  ): Promise<StaffContractSummary>;
  activate(
    contractId: string,
    input: { expectedVersion: number; idempotencyKey: string },
  ): Promise<StaffContractSummary>;
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
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
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

  async listInventory(): Promise<StaffAssetSummary[]> {
    const body = await this.request("/v1/staff/assets");
    if (!Array.isArray(body)) throw malformedStaff("MALFORMED_ASSET_LIST");
    return body.map(mapAssetSummary);
  }

  async assignVehicle(
    applicationId: string,
    input: {
      vehicleUnitId: string;
      expectedVehicleVersion: number;
      previousAssignmentId?: string;
      reassignmentApproval?: { approvedBy: string; reason: string };
      idempotencyKey: string;
    },
  ): Promise<StaffAssignmentSummary> {
    const body = await this.request(
      `/v1/staff/applications/${encodeURIComponent(applicationId)}/asset-assignment`,
      { method: "POST", body: input },
    );
    return mapAssignmentSummary(body);
  }

  async get(applicationId: string): Promise<StaffContractSummary | null> {
    const body = await this.request(
      `/v1/staff/applications/${encodeURIComponent(applicationId)}/contract`,
    );
    return body === null ? null : mapContractSummary(body);
  }

  async generate(
    applicationId: string,
    input: {
      assignmentId: string;
      templateVersionId?: string;
      idempotencyKey: string;
    },
  ): Promise<StaffContractSummary> {
    const body = await this.request(
      `/v1/staff/applications/${encodeURIComponent(applicationId)}/contracts`,
      { method: "POST", body: input },
    );
    return mapContractSummary(body);
  }

  async recordExecution(
    contractId: string,
    input: {
      expectedVersion: number;
      applicantSignature: string;
      guarantorSignature: string;
      staffWitnessId: string;
      executionDate: string;
      headOfficeLocation?: string;
      executedDocumentId: string;
      executedDocumentHash: string;
      authorizationReason?: string;
      idempotencyKey: string;
    },
  ): Promise<StaffContractSummary> {
    const body = await this.request(
      `/v1/staff/contracts/${encodeURIComponent(contractId)}/execution`,
      { method: "POST", body: input },
    );
    return mapContractSummary(body);
  }

  async completeHandover(
    contractId: string,
    input: {
      expectedVersion: number;
      checklistVersion: string;
      checklist: Record<string, unknown>;
      customerAcknowledged: true;
      customerAcknowledgedByPersonId?: string;
      condition: Record<string, unknown>;
      accessories: readonly string[];
      headOfficeLocation: string;
      handedOverAt: string;
      idempotencyKey: string;
    },
  ): Promise<StaffContractSummary> {
    const body = await this.request(
      `/v1/staff/contracts/${encodeURIComponent(contractId)}/handover`,
      { method: "POST", body: input },
    );
    return mapContractSummary(body);
  }

  async activate(
    contractId: string,
    input: { expectedVersion: number; idempotencyKey: string },
  ): Promise<StaffContractSummary> {
    const body = await this.request(
      `/v1/staff/contracts/${encodeURIComponent(contractId)}/activate`,
      { method: "POST", body: input },
    );
    return mapContractSummary(body);
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
    input: {
      effectiveFrom: string;
      effectiveUntil?: string;
      idempotencyKey: string;
    },
  ): Promise<void> {
    await this.request(
      `/v1/staff/products/rule-versions/${encodeURIComponent(ruleId)}/publish`,
      {
        method: "POST",
        body: input,
      },
    );
  }

  async decideException(
    exceptionId: string,
    input: {
      expectedVersion: number;
      decision: "APPROVE" | "REJECT";
      reason: string;
    },
  ): Promise<void> {
    await this.request(
      `/v1/staff/exceptions/${encodeURIComponent(exceptionId)}/decide`,
      {
        method: "POST",
        body: { ...input, idempotencyKey: crypto.randomUUID() },
      },
    );
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

function mapAssetSummary(value: unknown): StaffAssetSummary {
  if (!isRecord(value)) throw malformedStaff("MALFORMED_ASSET_LIST");
  if (!isRecord(value.condition) || !isStringArray(value.accessories)) {
    throw malformedStaff("MALFORMED_ASSET_LIST");
  }
  return {
    id: requiredString(value.id, "MALFORMED_ASSET_LIST"),
    vehicleModelId: requiredString(
      value.vehicleModelId,
      "MALFORMED_ASSET_LIST",
    ),
    vin: requiredString(value.vin, "MALFORMED_ASSET_LIST"),
    chassisNumber: requiredString(value.chassisNumber, "MALFORMED_ASSET_LIST"),
    engineMotorIdentifier: nullableString(
      value.engineMotorIdentifier,
      "MALFORMED_ASSET_LIST",
    ),
    condition: value.condition,
    accessories: value.accessories,
    trackerIdentifier: nullableString(
      value.trackerIdentifier,
      "MALFORMED_ASSET_LIST",
    ),
    registrationNumber: nullableString(
      value.registrationNumber,
      "MALFORMED_ASSET_LIST",
    ),
    status: requiredString(value.status, "MALFORMED_ASSET_LIST"),
    version: requiredInteger(value.version, "MALFORMED_ASSET_LIST"),
  };
}

function mapAssignmentSummary(value: unknown): StaffAssignmentSummary {
  if (!isRecord(value)) throw malformedStaff("MALFORMED_ASSIGNMENT_DTO");
  return {
    id: requiredString(value.id, "MALFORMED_ASSIGNMENT_DTO"),
    applicationId: requiredString(
      value.applicationId,
      "MALFORMED_ASSIGNMENT_DTO",
    ),
    vehicleUnitId: requiredString(
      value.vehicleUnitId,
      "MALFORMED_ASSIGNMENT_DTO",
    ),
    offerId: requiredString(value.offerId, "MALFORMED_ASSIGNMENT_DTO"),
    offerVersionId: requiredString(
      value.offerVersionId,
      "MALFORMED_ASSIGNMENT_DTO",
    ),
    depositReconciledAmountMinor: requiredString(
      value.depositReconciledAmountMinor,
      "MALFORMED_ASSIGNMENT_DTO",
    ),
    depositEvidenceId: requiredString(
      value.depositEvidenceId,
      "MALFORMED_ASSIGNMENT_DTO",
    ),
    supersedesAssignmentId: nullableString(
      value.supersedesAssignmentId,
      "MALFORMED_ASSIGNMENT_DTO",
    ),
    assignedAt: requiredString(value.assignedAt, "MALFORMED_ASSIGNMENT_DTO"),
    version: requiredInteger(value.version, "MALFORMED_ASSIGNMENT_DTO"),
  };
}

function mapContractSummary(value: unknown): StaffContractSummary {
  if (!isRecord(value)) throw malformedStaff("MALFORMED_CONTRACT_DTO");
  const statuses: StaffContractStatus[] = [
    "DRAFT",
    "AWAITING_EXECUTION",
    "EXECUTED",
    "ACTIVE",
    "SETTLED",
    "RECOVERY",
    "TERMINATED",
  ];
  if (!statuses.includes(value.status as StaffContractStatus))
    throw malformedStaff("MALFORMED_CONTRACT_DTO");
  if (value.ownershipHolder !== "SOMOCO")
    throw malformedStaff("MALFORMED_CONTRACT_DTO");
  return {
    id: requiredString(value.id, "MALFORMED_CONTRACT_DTO"),
    reference: requiredString(value.reference, "MALFORMED_CONTRACT_DTO"),
    applicationId: requiredString(
      value.applicationId,
      "MALFORMED_CONTRACT_DTO",
    ),
    offerVersionId: requiredString(
      value.offerVersionId,
      "MALFORMED_CONTRACT_DTO",
    ),
    vehicleUnitId: requiredString(
      value.vehicleUnitId,
      "MALFORMED_CONTRACT_DTO",
    ),
    status: value.status as StaffContractStatus,
    version: requiredInteger(value.version, "MALFORMED_CONTRACT_DTO"),
    canonicalHash: requiredString(
      value.canonicalHash,
      "MALFORMED_CONTRACT_DTO",
    ),
    previewReference: requiredString(
      value.previewReference,
      "MALFORMED_CONTRACT_DTO",
    ),
    ownershipHolder: "SOMOCO",
    outstandingBalanceMinor: requiredString(
      value.outstandingBalanceMinor,
      "MALFORMED_CONTRACT_DTO",
    ),
    generatedAt: requiredString(value.generatedAt, "MALFORMED_CONTRACT_DTO"),
    activatedAt: nullableString(value.activatedAt, "MALFORMED_CONTRACT_DTO"),
  };
}

function mapRuleSummary(value: unknown): ProductRuleSummary {
  if (!isRecord(value)) throw malformedStaff("MALFORMED_RULE_LIST");
  const id = requiredString(value.id, "MALFORMED_RULE_LIST");
  const versionNumber = requiredInteger(
    value.versionNumber,
    "MALFORMED_RULE_LIST",
  );
  const status =
    value.status === "DRAFT" || value.status === "PUBLISHED"
      ? value.status
      : malformedStaff("MALFORMED_RULE_LIST");
  const gate =
    value.gate === "OPEN" || value.gate === "CLOSED"
      ? value.gate
      : malformedStaff("MALFORMED_RULE_LIST");
  const requestedBy =
    value.requestedBy === null
      ? null
      : requiredString(value.requestedBy, "MALFORMED_RULE_LIST");
  const effectiveFrom =
    value.effectiveFrom === null
      ? null
      : requiredString(value.effectiveFrom, "MALFORMED_RULE_LIST");
  const effectiveUntil =
    value.effectiveUntil === undefined || value.effectiveUntil === null
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
  if (typeof value.licencePermitted === "boolean")
    result.licencePermitted = value.licencePermitted;
  if (value.disclosureVersion !== undefined) {
    result.disclosureVersion =
      value.disclosureVersion === null
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
  const status =
    value.status === "PENDING" ||
    value.status === "APPROVED" ||
    value.status === "REJECTED"
      ? value.status
      : malformedStaff("MALFORMED_EXCEPTION_LIST");
  return {
    id: requiredString(value.id, "MALFORMED_EXCEPTION_LIST"),
    status,
    requestedBy: requiredString(value.requestedBy, "MALFORMED_EXCEPTION_LIST"),
    requiredApproverRole: requiredString(
      value.requiredApproverRole,
      "MALFORMED_EXCEPTION_LIST",
    ),
    proposedValue: value.proposedValue,
    policyValue: value.policyValue,
    reason: requiredString(value.reason, "MALFORMED_EXCEPTION_LIST"),
    version: requiredInteger(value.version, "MALFORMED_EXCEPTION_LIST"),
  };
}

function malformedStaff(code: string): never {
  throw new ProblemError(code, 502, "The staff financing response is invalid.");
}

function requiredString(
  value: unknown,
  code = "MALFORMED_FINANCING_DTO",
): string {
  if (typeof value !== "string" || value.trim().length === 0)
    return malformedStaff(code);
  return value;
}

function requiredInteger(
  value: unknown,
  code = "MALFORMED_FINANCING_DTO",
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    return malformedStaff(code);
  return value;
}

function nullableString(value: unknown, code: string): string | null {
  if (value === null || value === undefined) return null;
  return requiredString(value, code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}
