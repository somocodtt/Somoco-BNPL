import type {
  ContractApi,
  CustomerContractStatus,
  CustomerContractView,
} from "../features/contract/contract-panel.js";

export interface CustomerSession {
  sessionToken: string;
  expiresAt: string;
}

export interface DraftSummary {
  id: string;
  status: string;
  version: number;
  vehicleModelId: string | null;
  applicantProfile: Record<string, unknown>;
}

export interface VehicleModel {
  id: string;
  manufacturer: string;
  modelName: string;
  modelYear: number;
}

export interface Completeness {
  ready: boolean;
  missing: string[];
  documentProgress: {
    applicant: { accepted: string[]; required: string[] };
    guarantor: { accepted: string[]; required: string[] };
  };
}

export interface OnboardingState {
  draft: DraftSummary | null;
  models: VehicleModel[];
  completeness: Completeness;
  guarantorStatus: "NOT_INVITED" | "INVITED" | "EXPIRED" | "CONFIRMED";
  guarantorInvitation: {
    status: "NOT_INVITED" | "INVITED" | "EXPIRED" | "CONFIRMED";
    relationshipVersion: number | null;
    expiresAt: string | null;
  };
}

export interface UploadTicket {
  documentId: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface ApplicantMutation {
  expectedVersion: number;
  mutationId: string;
  vehicleModelId: string;
  profile: { occupation: string; residentialArea: string };
}

export interface CustomerApi {
  requestOtp(phoneE164: string): Promise<void>;
  verifyOtp(phoneE164: string, code: string): Promise<CustomerSession>;
  loadOnboarding(): Promise<OnboardingState>;
  createDraft(): Promise<DraftSummary>;
  recordConsent(input: {
    purpose: string;
    documentVersion: string;
    phoneE164: string;
  }): Promise<{ consentId: string }>;
  verifyGhanaCard(input: {
    consentId: string;
    ghanaCardNumber: string;
    idempotencyKey: string;
  }): Promise<{ status: "VERIFIED" | "FAILED" | "MANUAL_REVIEW" }>;
  requestDocumentUpload(input: {
    documentType: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<UploadTicket>;
  uploadDocument(
    ticket: UploadTicket,
    file: Blob,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<void>;
  completeDocumentUpload(documentId: string): Promise<{
    documentId: string;
    status: "ACCEPTED";
    sha256: string;
  }>;
  saveApplicant(
    applicationId: string,
    input: ApplicantMutation,
  ): Promise<DraftSummary>;
  inviteGuarantor(
    applicationId: string,
    input: {
      expectedVersion: number;
      mutationId: string;
      guarantorPhoneE164: string;
    },
  ): Promise<{
    invitationId: string;
    applicationVersion: number;
    relationshipVersion: number;
    expiresAt: string;
  }>;
  resolveGuarantorInvitation(invitationToken: string): Promise<{
    status: "INVITED" | "EXPIRED" | "CONFIRMED";
    relationshipVersion: number;
    applicationVersion: number;
    expiresAt: string;
  }>;
  saveGuarantor(
    invitationToken: string,
    input: {
      expectedVersion: number;
      mutationId: string;
      profile: Record<string, unknown>;
    },
  ): Promise<{ applicationVersion: number }>;
  submit(
    applicationId: string,
    input: { expectedVersion: number; mutationId: string },
  ): Promise<DraftSummary>;
}

export interface CustomerPaymentInstructions {
  channel: "USSD_MOBILE_MONEY";
  ussdInstructions: string;
  cashAccepted: false;
}

export interface CustomerPaymentRecord {
  id: string;
  providerTransactionId: string;
  amountMinorUnits: string;
  currency: "GHS";
  status: string;
  occurredAt: string;
  contractReference: string | null;
  outstandingBalanceMinorUnits: string | null;
  nextDueDate: string | null;
}

export interface CustomerReceiptRecord {
  id: string;
  receiptNumber: string;
  paymentTransactionId: string;
  amountMinorUnits: string;
  currency: "GHS";
  issuedAt: string;
  securePath: string;
}

export interface CustomerPaymentsApi {
  getPaymentInstructions(): Promise<CustomerPaymentInstructions>;
  getPayments(): Promise<readonly CustomerPaymentRecord[]>;
  getReceipts(): Promise<readonly CustomerReceiptRecord[]>;
}

import type { CustomerOffer, OfferApi } from "../features/offer/offer-panel.js";

export class FetchCustomerApi
  implements CustomerApi, CustomerPaymentsApi, OfferApi, ContractApi
{
  #sessionToken: string | null = null;
  #offerVersions = new Map<string, number>();

  constructor(
    private readonly baseUrl = "",
    private readonly fetcher: typeof fetch = (input, init) =>
      globalThis.fetch(input, init),
  ) {}

  async requestOtp(phoneE164: string): Promise<void> {
    await this.request(
      "/v1/customer/otp/requests",
      {
        method: "POST",
        body: JSON.stringify({ phoneE164 }),
      },
      false,
    );
  }

  async verifyOtp(phoneE164: string, code: string): Promise<CustomerSession> {
    const result = await this.request<CustomerSession>(
      "/v1/customer/otp/verifications",
      { method: "POST", body: JSON.stringify({ phoneE164, code }) },
      false,
    );
    this.#sessionToken = result.sessionToken;
    return result;
  }

  async loadOnboarding(): Promise<OnboardingState> {
    const [models, resume] = await Promise.all([
      this.request<VehicleModel[]>("/v1/customer/vehicle-models"),
      this.request<{
        draft: DraftSummary | null;
        guarantorStatus: OnboardingState["guarantorStatus"];
        guarantorInvitation: OnboardingState["guarantorInvitation"];
      }>("/v1/customer/applications/resume"),
    ]);
    const draft = resume.draft ?? (await this.createDraft());
    const completeness = await this.request<Completeness>(
      `/v1/customer/applications/${draft.id}/completeness`,
    );
    return {
      draft,
      models,
      completeness,
      guarantorStatus: resume.guarantorStatus,
      guarantorInvitation: resume.guarantorInvitation,
    };
  }

  createDraft(): Promise<DraftSummary> {
    return this.request("/v1/customer/applications", { method: "POST" });
  }

  recordConsent(input: {
    purpose: string;
    documentVersion: string;
    phoneE164: string;
  }): Promise<{ consentId: string }> {
    return this.request("/v1/customer/consents", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  verifyGhanaCard(input: {
    consentId: string;
    ghanaCardNumber: string;
    idempotencyKey: string;
  }): Promise<{ status: "VERIFIED" | "FAILED" | "MANUAL_REVIEW" }> {
    return this.request("/v1/customer/identity/ghana-card-verifications", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  requestDocumentUpload(input: {
    documentType: string;
    mimeType: string;
    sizeBytes: number;
  }): Promise<UploadTicket> {
    return this.request("/v1/customer/documents/uploads", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  uploadDocument(
    ticket: UploadTicket,
    file: Blob,
    onProgress: (loaded: number, total: number) => void,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("PUT", ticket.uploadUrl);
      for (const [name, value] of Object.entries(ticket.requiredHeaders)) {
        if (name.toLowerCase() !== "content-length") {
          request.setRequestHeader(name, value);
        }
      }
      request.upload.addEventListener("progress", (event) => {
        onProgress(
          event.loaded,
          event.lengthComputable ? event.total : file.size,
        );
      });
      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) resolve();
        else reject(new Error("DOCUMENT_UPLOAD_FAILED"));
      });
      request.addEventListener("error", () =>
        reject(new TypeError("Failed to fetch")),
      );
      request.send(file);
    });
  }

  completeDocumentUpload(documentId: string) {
    return this.request<{
      documentId: string;
      status: "ACCEPTED";
      sha256: string;
    }>(`/v1/customer/documents/${documentId}/complete`, { method: "POST" });
  }

  saveApplicant(
    applicationId: string,
    input: ApplicantMutation,
  ): Promise<DraftSummary> {
    return this.request(
      `/v1/customer/applications/${applicationId}/applicant`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    );
  }

  inviteGuarantor(
    applicationId: string,
    input: {
      expectedVersion: number;
      mutationId: string;
      guarantorPhoneE164: string;
    },
  ) {
    return this.request<{
      invitationId: string;
      applicationVersion: number;
      relationshipVersion: number;
      expiresAt: string;
    }>(`/v1/customer/applications/${applicationId}/guarantor-invitations`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  resolveGuarantorInvitation(invitationToken: string) {
    return this.request<{
      status: "INVITED" | "EXPIRED" | "CONFIRMED";
      relationshipVersion: number;
      applicationVersion: number;
      expiresAt: string;
    }>("/v1/customer/guarantor-invitations/resolutions", {
      method: "POST",
      body: JSON.stringify({ invitationToken }),
    });
  }

  saveGuarantor(
    invitationToken: string,
    input: {
      expectedVersion: number;
      mutationId: string;
      profile: Record<string, unknown>;
    },
  ) {
    return this.request<{ applicationVersion: number }>(
      "/v1/customer/guarantor",
      {
        method: "PATCH",
        body: JSON.stringify({ invitationToken, ...input }),
      },
    );
  }

  submit(
    applicationId: string,
    input: { expectedVersion: number; mutationId: string },
  ) {
    return this.request<DraftSummary>(
      `/v1/customer/applications/${applicationId}/submissions`,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    );
  }

  getPaymentInstructions(): Promise<CustomerPaymentInstructions> {
    return this.request("/v1/customer/payment-instructions");
  }

  getPayments(): Promise<readonly CustomerPaymentRecord[]> {
    return this.request("/v1/customer/payments");
  }

  getReceipts(): Promise<readonly CustomerReceiptRecord[]> {
    return this.request("/v1/customer/receipts");
  }

  async getContract(
    applicationId: string,
  ): Promise<CustomerContractView | null> {
    const result = await this.request<unknown>(
      `/v1/customer/applications/${encodeURIComponent(applicationId)}/contract`,
    );
    return result === null ? null : mapContractView(result);
  }

  acknowledgeHandover(
    contractId: string,
    input: {
      checklistVersion: string;
      checklist: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<{ id: string; acknowledgedAt: string }> {
    return this.request(
      `/v1/customer/contracts/${encodeURIComponent(contractId)}/handover-acknowledgement`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async get(applicationId: string): Promise<CustomerOffer | null> {
    const result = await this.request<Record<string, unknown> | null>(
      `/v1/customer/applications/${encodeURIComponent(applicationId)}/offer`,
    );
    return result === null ? null : this.mapOffer(result);
  }

  async accept(
    offerId: string,
    input: {
      consent: boolean;
      consentAt: string;
      expectedVersion?: number;
      disclosedVersion: string;
      disclosedHash: string;
    },
  ): Promise<CustomerOffer> {
    if (!input.consent) throw new Error("CONSENT_REQUIRED");
    const expectedVersion =
      input.expectedVersion ?? this.#offerVersions.get(offerId);
    if (expectedVersion === undefined)
      throw new Error("OFFER_VERSION_REQUIRED");
    const result = await this.request<Record<string, unknown>>(
      `/v1/customer/offers/${encodeURIComponent(offerId)}/accept`,
      {
        method: "POST",
        body: JSON.stringify({
          consent: true,
          expectedVersion,
          consentAt: input.consentAt,
          disclosedVersion: input.disclosedVersion,
          disclosedHash: input.disclosedHash,
          idempotencyKey: crypto.randomUUID(),
        }),
      },
    );
    return this.mapOffer(result);
  }

  private mapOffer(value: Record<string, unknown>): CustomerOffer {
    if (!isRecord(value)) throw malformedOffer();
    const id = requiredString(value.id ?? value.offerId, "id");
    const status = requiredStatus(value.status);
    const version = requiredInteger(value.version, "version", 1);
    const expiresAt = requiredDate(value.expiresAt, "expiresAt");
    const priceMinor = requiredMoney(value.priceMinor, "priceMinor");
    const depositMinor = requiredMoney(value.depositMinor, "depositMinor");
    const totalPayableMinor = requiredMoney(
      value.totalPayableMinor,
      "totalPayableMinor",
    );
    const financeChargeMinor = requiredMoney(
      value.financeChargeMinor,
      "financeChargeMinor",
    );
    const frequency =
      value.frequency === "WEEKLY" || value.frequency === "MONTHLY"
        ? value.frequency
        : malformedOffer();
    const tenureMonths = requiredTenure(value.tenureMonths);
    const disclosureVersion = requiredString(
      value.disclosureVersion,
      "disclosureVersion",
    );
    const disclosedHash = requiredHash(value.disclosedHash, "disclosedHash");
    const disclosureContent = isRecord(value.disclosureContent)
      ? value.disclosureContent
      : malformedOffer();
    const fees = isRecord(value.fees) ? value.fees : malformedOffer();
    if (!Array.isArray(value.installments) || value.installments.length === 0)
      throw malformedOffer();
    const installments = value.installments.map((item) => {
      if (!isRecord(item)) throw malformedOffer();
      return {
        sequence: requiredInteger(item.sequence, "installment.sequence", 1),
        dueDate: requiredDateOnly(item.dueDate, "installment.dueDate"),
        totalMinor: requiredMoney(item.totalMinor, "installment.totalMinor"),
      };
    });
    const offer: CustomerOffer = {
      id,
      version,
      status,
      expiresAt,
      priceMinor,
      depositMinor,
      frequency,
      tenureMonths,
      totalPayableMinor,
      financeChargeMinor,
      installments,
      disclosureVersion,
      disclosureContent,
      fees,
      disclosedHash,
    };
    this.#offerVersions.set(offer.id, offer.version);
    return offer;
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    authenticated = true,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (authenticated) {
      if (this.#sessionToken === null)
        throw new Error("CUSTOMER_SESSION_REQUIRED");
      headers.set("authorization", `Bearer ${this.#sessionToken}`);
    }
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      cache: "no-store",
    });
    const body = (await response.json()) as unknown;
    if (!response.ok) throw body;
    return body as T;
  }
}

export class CustomerApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function mapContractView(value: unknown): CustomerContractView {
  if (!isRecord(value)) throw malformedContract();
  const statuses: CustomerContractStatus[] = [
    "DRAFT",
    "AWAITING_EXECUTION",
    "EXECUTED",
    "ACTIVE",
    "SETTLED",
    "RECOVERY",
    "TERMINATED",
  ];
  if (!statuses.includes(value.status as CustomerContractStatus))
    throw malformedContract();
  if (
    typeof value.previewAvailable !== "boolean" ||
    typeof value.executed !== "boolean" ||
    typeof value.assignedVehicleAvailable !== "boolean"
  ) {
    throw malformedContract();
  }
  if (!Array.isArray(value.schedule)) throw malformedContract();
  return {
    contractId: requiredString(value.contractId, "contractId"),
    status: value.status as CustomerContractStatus,
    previewAvailable: value.previewAvailable,
    executed: value.executed,
    assignedVehicleAvailable: value.assignedVehicleAvailable,
    registrationNumber: nullableContractString(value.registrationNumber),
    registrationValidTo: nullableContractString(value.registrationValidTo),
    insuranceValidTo: nullableContractString(value.insuranceValidTo),
    handoverAcknowledged: value.handoverAcknowledged === true,
    schedule: value.schedule.map((item) => {
      if (
        !isRecord(item) ||
        typeof item.sequence !== "number" ||
        !Number.isSafeInteger(item.sequence) ||
        item.sequence < 1 ||
        typeof item.dueDate !== "string" ||
        !/^\d+$/.test(String(item.totalMinor))
      ) {
        throw malformedContract();
      }
      const sequence = item.sequence;
      return {
        sequence,
        dueDate: item.dueDate,
        totalMinor: String(item.totalMinor),
      };
    }),
  };
}

function malformedContract(): never {
  throw new CustomerApiError(
    "MALFORMED_CONTRACT_DTO",
    "The customer contract response is invalid.",
  );
}

function nullableContractString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.trim().length === 0)
    throw malformedContract();
  return value;
}

function malformedOffer(field = "offer"): never {
  throw new CustomerApiError(
    "MALFORMED_OFFER_DTO",
    `The financing offer ${field} is invalid.`,
  );
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    return malformedOffer(field);
  return value;
}

function requiredMoney(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d+$/.test(value))
    return malformedOffer(field);
  return value;
}

function requiredHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value))
    return malformedOffer(field);
  return value;
}

function requiredInteger(
  value: unknown,
  field: string,
  minimum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    return malformedOffer(field);
  return value;
}

function requiredDate(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (!Number.isFinite(Date.parse(result))) return malformedOffer(field);
  return result;
}

function requiredDateOnly(value: unknown, field: string): string {
  const result = requiredString(value, field);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(result) ||
    !Number.isFinite(Date.parse(`${result}T00:00:00Z`))
  )
    return malformedOffer(field);
  return result;
}

function requiredTenure(value: unknown): CustomerOffer["tenureMonths"] {
  if (
    value === 6 ||
    value === 8 ||
    value === 12 ||
    value === 24 ||
    value === 36 ||
    value === 48
  )
    return value;
  return malformedOffer();
}

function requiredStatus(value: unknown): CustomerOffer["status"] {
  if (
    value === "PENDING" ||
    value === "EXPIRED" ||
    value === "ACCEPTED" ||
    value === "CANCELLED"
  )
    return value;
  return malformedOffer();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
