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

import type { CustomerOffer, OfferApi } from "../features/offer/offer-panel.js";

export class FetchCustomerApi implements CustomerApi, OfferApi {
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
        onProgress(event.loaded, event.lengthComputable ? event.total : file.size);
      });
      request.addEventListener("load", () => {
        if (request.status >= 200 && request.status < 300) resolve();
        else reject(new Error("DOCUMENT_UPLOAD_FAILED"));
      });
      request.addEventListener("error", () => reject(new TypeError("Failed to fetch")));
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
    }>(
      `/v1/customer/applications/${applicationId}/guarantor-invitations`,
      { method: "POST", body: JSON.stringify(input) },
    );
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

  async get(applicationId: string): Promise<CustomerOffer | null> {
    const result = await this.request<Record<string, unknown> | null>(
      `/v1/customer/applications/${encodeURIComponent(applicationId)}/offer`,
    );
    return result === null ? null : this.mapOffer(result);
  }

  async accept(
    offerId: string,
    input: { consent: boolean; consentAt: string; expectedVersion?: number },
  ): Promise<CustomerOffer> {
    if (!input.consent) throw new Error("CONSENT_REQUIRED");
    const expectedVersion = input.expectedVersion ?? this.#offerVersions.get(offerId);
    if (expectedVersion === undefined) throw new Error("OFFER_VERSION_REQUIRED");
    const result = await this.request<Record<string, unknown>>(
      `/v1/customer/offers/${encodeURIComponent(offerId)}/accept`,
      { method: "POST", body: JSON.stringify({ expectedVersion, consentAt: input.consentAt, idempotencyKey: crypto.randomUUID() }) },
    );
    return this.mapOffer(result);
  }

  private mapOffer(value: Record<string, unknown>): CustomerOffer {
    const installments = Array.isArray(value.installments) ? value.installments : [];
    const offer: CustomerOffer = {
      id: stringValue(value.id) ?? stringValue(value.offerId) ?? "",
      version: numberValue(value.version) ?? 1,
      status: statusValue(value.status),
      expiresAt: stringValue(value.expiresAt) ?? "",
      priceMinor: moneyValue(value.priceMinor),
      depositMinor: moneyValue(value.depositMinor),
      frequency: value.frequency === "WEEKLY" ? "WEEKLY" : "MONTHLY",
      tenureMonths: tenureValue(value.tenureMonths),
      totalPayableMinor: moneyValue(value.totalPayableMinor),
      financeChargeMinor: moneyValue(value.financeChargeMinor),
      installments: installments.map((item) => {
        const row = (item ?? {}) as Record<string, unknown>;
        return {
          sequence: numberValue(row.sequence) ?? 0,
          dueDate: stringValue(row.dueDate) ?? "",
          totalMinor: moneyValue(row.totalMinor),
        };
      }),
      disclosureVersion: stringValue(value.disclosureVersion),
      fees: isRecord(value.fees) ? value.fees : {},
      disclosedHash: stringValue(value.disclosedHash),
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function moneyValue(value: unknown): string {
  return typeof value === "string" && /^\d+$/.test(value) ? value : "0";
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function tenureValue(value: unknown): CustomerOffer["tenureMonths"] {
  return value === 8 || value === 12 || value === 24 || value === 36 || value === 48 ? value : 6;
}

function statusValue(value: unknown): CustomerOffer["status"] {
  return value === "EXPIRED" || value === "ACCEPTED" || value === "CANCELLED" ? value : "PENDING";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
