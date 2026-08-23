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

export interface StaffPaymentWorkspaceData {
  inbox: readonly Record<string, unknown>[];
  cases: readonly Record<string, unknown>[];
  settlements: readonly Record<string, unknown>[];
  adjustments: readonly Record<string, unknown>[];
}

export interface StaffPaymentsApi {
  listPaymentInbox(): Promise<readonly Record<string, unknown>[]>;
  listReconciliationCases(): Promise<readonly Record<string, unknown>[]>;
  resolveReconciliationCase(
    caseId: string,
    input: { resolution: Record<string, unknown> },
  ): Promise<void>;
  listSettlements(): Promise<readonly Record<string, unknown>[]>;
  compareSettlement(input: {
    settlementReference: string;
    providerTotalMinorUnits: string;
  }): Promise<Record<string, unknown>>;
  listAdjustments(): Promise<readonly Record<string, unknown>[]>;
  requestAdjustment(input: {
    contractId: string;
    amountMinorUnits: string;
    direction: "DEBIT" | "CREDIT";
    reason: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: "PENDING" }>;
  decideAdjustment(
    adjustmentId: string,
    input: { decision: "APPROVE" | "REJECT"; reason: string },
  ): Promise<{ id: string; status: "APPROVED" | "REJECTED" }>;
}

export type StaffReportName =
  "operations" | "portfolio" | "audit" | "migration";

export interface StaffReportsApi {
  getReport(
    name: StaffReportName,
    filters?: {
      status?: string;
      asOfDate?: string;
      includePersonalData?: boolean;
      cursor?: string;
    },
  ): Promise<Record<string, unknown>>;
  exportReport(input: {
    report: StaffReportName;
    format: "CSV" | "JSON";
    filters?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  getExport(exportId: string): Promise<Record<string, unknown>>;
}

export interface StaffMigrationApi {
  listBatches(): Promise<readonly Record<string, unknown>[]>;
  importBatch(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  validate(batchId: string): Promise<Record<string, unknown>>;
  verify(
    batchId: string,
    sampleRecordIds: readonly string[],
  ): Promise<Record<string, unknown>>;
  approve(
    batchId: string,
    financialEvidenceHash: string,
  ): Promise<Record<string, unknown>>;
  activateMigration(batchId: string): Promise<Record<string, unknown>>;
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
  recordRegistration(
    vehicleUnitId: string,
    input: {
      registrationNumber: string;
      validFrom: string;
      validTo: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    },
  ): Promise<{
    vehicleUnitId: string;
    registrationNumber: string;
    validTo: string;
    version: number;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  }>;
  recordInsurance(
    vehicleUnitId: string,
    input: {
      policyNumber: string;
      provider: string;
      validFrom: string;
      validTo: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    },
  ): Promise<{
    vehicleUnitId: string;
    policyNumber: string;
    validTo: string;
    version: number;
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
  }>;
  associateTracker(
    vehicleUnitId: string,
    input: {
      trackerId: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    },
  ): Promise<{ vehicleUnitId: string; version: number }>;
  assignVehicle(
    applicationId: string,
    input: {
      vehicleUnitId: string;
      expectedVehicleVersion: number;
      previousAssignmentId?: string;
      reassignmentApproval?: { approvalId: string };
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
      applicantPersonId: string;
      guarantorPersonId: string;
      staffWitnessId: string;
      executionDate: string;
      headOfficeId: string;
      headOfficeLocation: string;
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
      customerAcknowledgementId: string;
      customerAcknowledgedByPersonId?: string;
      condition: { description: string; checkResult: string };
      accessories: { items: readonly string[]; none?: boolean };
      headOfficeId: string;
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
import type { StaffCollectionsApi } from "../features/collections/collections-workspace.js";

export class ProblemError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}

export class FetchStaffApi
  implements
    StaffApi,
    ProductApi,
    StaffPaymentsApi,
    StaffCollectionsApi,
    StaffReportsApi,
    StaffMigrationApi
{
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

  async listArrears(): Promise<readonly Record<string, unknown>[]> {
    return arrayOfRecords(
      await this.request("/v1/staff/collections/arrears"),
      "MALFORMED_COLLECTIONS_ARREARS",
    );
  }

  async getReport(
    name: StaffReportName,
    filters: {
      status?: string;
      asOfDate?: string;
      includePersonalData?: boolean;
      cursor?: string;
    } = {},
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams();
    if (filters.status !== undefined) query.set("status", filters.status);
    if (filters.asOfDate !== undefined) query.set("asOfDate", filters.asOfDate);
    if (filters.includePersonalData === true)
      query.set("includePersonalData", "true");
    if (filters.cursor !== undefined) query.set("cursor", filters.cursor);
    const suffix = query.toString() === "" ? "" : `?${query.toString()}`;
    const body = await this.request(`/v1/staff/reports/${name}${suffix}`);
    if (!isRecord(body)) throw malformedStaff("MALFORMED_REPORT");
    return body;
  }

  async exportReport(input: {
    report: StaffReportName;
    format: "CSV" | "JSON";
    filters?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> {
    const body = await this.request("/v1/staff/reports/exports", {
      method: "POST",
      body: input,
    });
    if (!isRecord(body)) throw malformedStaff("MALFORMED_REPORT_EXPORT");
    return body;
  }

  async getExport(exportId: string): Promise<Record<string, unknown>> {
    const body = await this.request(
      `/v1/staff/reports/exports/${encodeURIComponent(exportId)}`,
    );
    if (!isRecord(body)) throw malformedStaff("MALFORMED_REPORT_EXPORT");
    return body;
  }

  async listBatches(): Promise<readonly Record<string, unknown>[]> {
    return arrayOfRecords(
      await this.request("/v1/staff/migrations"),
      "MALFORMED_MIGRATION_LIST",
    );
  }

  async importBatch(
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const body = await this.request("/v1/staff/migrations/import", {
      method: "POST",
      body: input,
    });
    if (!isRecord(body)) throw malformedStaff("MALFORMED_MIGRATION_BATCH");
    return body;
  }

  async validate(batchId: string): Promise<Record<string, unknown>> {
    const body = await this.request(
      `/v1/staff/migrations/${encodeURIComponent(batchId)}/validate`,
      { method: "POST", body: {} },
    );
    if (!isRecord(body)) throw malformedStaff("MALFORMED_MIGRATION_BATCH");
    return body;
  }

  async verify(
    batchId: string,
    sampleRecordIds: readonly string[],
  ): Promise<Record<string, unknown>> {
    const body = await this.request(
      `/v1/staff/migrations/${encodeURIComponent(batchId)}/verify`,
      {
        method: "POST",
        body: { sampleRecordIds },
      },
    );
    if (!isRecord(body)) throw malformedStaff("MALFORMED_MIGRATION_BATCH");
    return body;
  }

  async approve(
    batchId: string,
    financialEvidenceHash: string,
  ): Promise<Record<string, unknown>> {
    const body = await this.request(
      `/v1/staff/migrations/${encodeURIComponent(batchId)}/approve`,
      { method: "POST", body: { financialEvidenceHash } },
    );
    if (!isRecord(body)) throw malformedStaff("MALFORMED_MIGRATION_BATCH");
    return body;
  }

  async activateMigration(batchId: string): Promise<Record<string, unknown>> {
    const body = await this.request(
      `/v1/staff/migrations/${encodeURIComponent(batchId)}/activate`,
      { method: "POST", body: {} },
    );
    if (!isRecord(body)) throw malformedStaff("MALFORMED_MIGRATION_BATCH");
    return body;
  }

  async listCases(): Promise<readonly Record<string, unknown>[]> {
    return arrayOfRecords(
      await this.request("/v1/staff/collections/cases"),
      "MALFORMED_COLLECTIONS_CASES",
    );
  }

  async decideRecoveryCase(
    recoveryCaseId: string,
    input: {
      decision: "APPROVED" | "DENIED";
      purpose: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>> {
    const result = await this.request(
      `/v1/staff/collections/cases/${encodeURIComponent(recoveryCaseId)}/decision`,
      { method: "POST", body: input },
    );
    if (!isRecord(result))
      throw malformedStaff("MALFORMED_COLLECTION_DECISION");
    return result;
  }

  async getRecoveryLocation(
    recoveryCaseId: string,
    purpose: string,
  ): Promise<Record<string, unknown>> {
    const query = new URLSearchParams({ purpose });
    const result = await this.request(
      `/v1/staff/collections/cases/${encodeURIComponent(recoveryCaseId)}/location?${query.toString()}`,
    );
    if (!isRecord(result))
      throw malformedStaff("MALFORMED_COLLECTION_LOCATION");
    return result;
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

  async recordRegistration(
    vehicleUnitId: string,
    input: {
      registrationNumber: string;
      validFrom: string;
      validTo: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    },
  ) {
    const body = await this.request(
      `/v1/staff/assets/${encodeURIComponent(vehicleUnitId)}/registration`,
      { method: "POST", body: input },
    );
    return mapCoverageResponse(body, "registration") as {
      vehicleUnitId: string;
      registrationNumber: string;
      validTo: string;
      version: number;
      renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
    };
  }

  async recordInsurance(
    vehicleUnitId: string,
    input: {
      policyNumber: string;
      provider: string;
      validFrom: string;
      validTo: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    },
  ) {
    const body = await this.request(
      `/v1/staff/assets/${encodeURIComponent(vehicleUnitId)}/insurance`,
      { method: "POST", body: input },
    );
    return mapCoverageResponse(body, "insurance") as {
      vehicleUnitId: string;
      policyNumber: string;
      validTo: string;
      version: number;
      renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
    };
  }

  async associateTracker(
    vehicleUnitId: string,
    input: {
      trackerId: string;
      expectedVehicleVersion: number;
      idempotencyKey: string;
    },
  ) {
    const body = await this.request(
      `/v1/staff/assets/${encodeURIComponent(vehicleUnitId)}/tracker`,
      { method: "POST", body: input },
    );
    if (
      !isRecord(body) ||
      typeof body.vehicleUnitId !== "string" ||
      typeof body.version !== "number"
    )
      throw malformedStaff("MALFORMED_TRACKER_RESPONSE");
    return { vehicleUnitId: body.vehicleUnitId, version: body.version };
  }

  async assignVehicle(
    applicationId: string,
    input: {
      vehicleUnitId: string;
      expectedVehicleVersion: number;
      previousAssignmentId?: string;
      reassignmentApproval?: { approvalId: string };
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
      applicantPersonId: string;
      guarantorPersonId: string;
      staffWitnessId: string;
      executionDate: string;
      headOfficeId: string;
      headOfficeLocation: string;
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
      customerAcknowledgementId: string;
      customerAcknowledgedByPersonId?: string;
      condition: { description: string; checkResult: string };
      accessories: { items: readonly string[]; none?: boolean };
      headOfficeId: string;
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

  async listPaymentInbox(): Promise<readonly Record<string, unknown>[]> {
    return arrayOfRecords(
      await this.request("/v1/staff/payments/inbox"),
      "MALFORMED_PAYMENT_INBOX",
    );
  }

  async listReconciliationCases(): Promise<readonly Record<string, unknown>[]> {
    return arrayOfRecords(
      await this.request("/v1/staff/payments/reconciliation"),
      "MALFORMED_RECONCILIATION_CASES",
    );
  }

  async resolveReconciliationCase(
    caseId: string,
    input: { resolution: Record<string, unknown> },
  ): Promise<void> {
    await this.request(
      `/v1/staff/payments/reconciliation/${encodeURIComponent(caseId)}/resolve`,
      { method: "POST", body: input },
    );
  }

  async listSettlements(): Promise<readonly Record<string, unknown>[]> {
    return arrayOfRecords(
      await this.request("/v1/staff/payments/settlements"),
      "MALFORMED_PAYMENT_SETTLEMENTS",
    );
  }

  async compareSettlement(input: {
    settlementReference: string;
    providerTotalMinorUnits: string;
  }): Promise<Record<string, unknown>> {
    const body = await this.request("/v1/staff/payments/settlements/compare", {
      method: "POST",
      body: input,
    });
    if (!isRecord(body))
      throw malformedStaff("MALFORMED_SETTLEMENT_COMPARISON");
    return body;
  }

  async listAdjustments(): Promise<readonly Record<string, unknown>[]> {
    return arrayOfRecords(
      await this.request("/v1/staff/payments/adjustments"),
      "MALFORMED_PAYMENT_ADJUSTMENTS",
    );
  }

  async requestAdjustment(input: {
    contractId: string;
    amountMinorUnits: string;
    direction: "DEBIT" | "CREDIT";
    reason: string;
    idempotencyKey: string;
  }): Promise<{ id: string; status: "PENDING" }> {
    const body = await this.request("/v1/staff/payments/adjustments", {
      method: "POST",
      body: input,
    });
    if (
      !isRecord(body) ||
      typeof body.id !== "string" ||
      body.status !== "PENDING"
    )
      throw malformedStaff("MALFORMED_PAYMENT_ADJUSTMENT");
    return { id: body.id, status: "PENDING" };
  }

  async decideAdjustment(
    adjustmentId: string,
    input: { decision: "APPROVE" | "REJECT"; reason: string },
  ): Promise<{ id: string; status: "APPROVED" | "REJECTED" }> {
    const body = await this.request(
      `/v1/staff/payments/adjustments/${encodeURIComponent(adjustmentId)}/decision`,
      { method: "POST", body: input },
    );
    if (
      !isRecord(body) ||
      typeof body.id !== "string" ||
      (body.status !== "APPROVED" && body.status !== "REJECTED")
    )
      throw malformedStaff("MALFORMED_PAYMENT_ADJUSTMENT");
    return { id: body.id, status: body.status };
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

function arrayOfRecords(
  value: unknown,
  code: string,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value) || value.some((item) => !isRecord(item)))
    throw malformedStaff(code);
  return value;
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

function mapCoverageResponse(
  value: unknown,
  kind: "registration" | "insurance",
): {
  vehicleUnitId: string;
  registrationNumber?: string;
  policyNumber?: string;
  validTo: string;
  version: number;
  renewalWarningState: "RENEWAL_REVIEW_REQUIRED";
} {
  if (
    !isRecord(value) ||
    typeof value.vehicleUnitId !== "string" ||
    typeof value.validTo !== "string" ||
    typeof value.version !== "number" ||
    value.renewalWarningState !== "RENEWAL_REVIEW_REQUIRED"
  )
    throw malformedStaff(`MALFORMED_${kind.toUpperCase()}_RESPONSE`);
  if (kind === "registration" && typeof value.registrationNumber !== "string")
    throw malformedStaff("MALFORMED_REGISTRATION_RESPONSE");
  if (kind === "insurance" && typeof value.policyNumber !== "string")
    throw malformedStaff("MALFORMED_INSURANCE_RESPONSE");
  return {
    vehicleUnitId: value.vehicleUnitId,
    ...(kind === "registration"
      ? { registrationNumber: value.registrationNumber as string }
      : { policyNumber: value.policyNumber as string }),
    validTo: value.validTo,
    version: value.version,
    renewalWarningState: "RENEWAL_REVIEW_REQUIRED",
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
