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
  guarantorStatus: "NOT_INVITED" | "INVITED" | "CONFIRMED";
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
  ): Promise<{ applicationVersion: number; expiresAt: string }>;
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

export class FetchCustomerApi implements CustomerApi {
  #sessionToken: string | null = null;

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
    };
  }

  createDraft(): Promise<DraftSummary> {
    return this.request("/v1/customer/applications", { method: "POST" });
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
    return this.request<{ applicationVersion: number; expiresAt: string }>(
      `/v1/customer/applications/${applicationId}/guarantor-invitations`,
      { method: "POST", body: JSON.stringify(input) },
    );
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
