import {
  applicantPhone,
  applicantPersonId,
  applicationId,
  guarantorPhone,
  guarantorPersonId,
  invitationToken,
  otpCode,
  type PilotHarness,
} from "./pilot-harness.js";

interface ApiResponse {
  status(): number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

interface ApiRequest {
  get(url: string, options?: Record<string, unknown>): Promise<ApiResponse>;
  post(url: string, options?: Record<string, unknown>): Promise<ApiResponse>;
  patch(url: string, options?: Record<string, unknown>): Promise<ApiResponse>;
}

export function api(request: ApiRequest): ApiRequest {
  return request;
}

export async function call(
  request: ApiRequest,
  baseUrl: string,
  method: "get" | "post" | "patch",
  path: string,
  options: {
    token?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Promise<ApiResponse> {
  const headers = {
    ...(options.token === undefined
      ? {}
      : { authorization: `Bearer ${options.token}` }),
    ...(options.body === undefined
      ? {}
      : { "content-type": "application/json" }),
    ...options.headers,
  };
  const requestOptions = {
    headers,
    ...(options.body === undefined ? {} : { data: options.body }),
  };
  return request[method](`${baseUrl}${path}`, requestOptions);
}

export async function body(
  response: ApiResponse,
): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};
  return parsed as Record<string, unknown>;
}

export async function json(response: ApiResponse): Promise<unknown> {
  return response.json();
}

export async function authenticateApplicant(
  request: ApiRequest,
  harness: PilotHarness,
): Promise<void> {
  const otpRequest = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/otp/requests",
    { body: { phoneE164: applicantPhone } },
  );
  assertStatus(otpRequest, 202);
  const verified = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/otp/verifications",
    { body: { phoneE164: applicantPhone, code: otpCode } },
  );
  assertStatus(verified, 201);
  const result = await body(verified);
  if (result.sessionToken !== harness.applicantToken)
    throw new Error("APPLICANT_SESSION_FIXTURE_MISMATCH");
}

export async function authenticateGuarantor(
  request: ApiRequest,
  harness: PilotHarness,
): Promise<void> {
  const otpRequest = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/otp/requests",
    { body: { phoneE164: guarantorPhone } },
  );
  assertStatus(otpRequest, 202);
  const verified = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/otp/verifications",
    { body: { phoneE164: guarantorPhone, code: otpCode } },
  );
  assertStatus(verified, 201);
  const result = await body(verified);
  if (result.sessionToken !== harness.guarantorToken)
    throw new Error("GUARANTOR_SESSION_FIXTURE_MISMATCH");
}

export async function completeOnboarding(
  request: ApiRequest,
  harness: PilotHarness,
): Promise<void> {
  await authenticateApplicant(request, harness);
  const applicantHeaders = { token: harness.applicantToken };
  const consent = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/consents",
    {
      ...applicantHeaders,
      body: {
        purpose: "NIA_IDENTITY_VERIFICATION",
        documentVersion: "nia-consent-v1",
        phoneE164: applicantPhone,
      },
    },
  );
  assertStatus(consent, 201);
  const consentBody = await body(consent);
  const nia = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/identity/ghana-card-verifications",
    {
      ...applicantHeaders,
      body: {
        consentId: consentBody.consentId as string,
        ghanaCardNumber: "GHA-123456789-1",
        idempotencyKey: "31000000-0000-4000-8000-000000000001",
      },
    },
  );
  assertStatus(nia, 201);
  const upload = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/documents/uploads",
    {
      ...applicantHeaders,
      body: {
        documentType: "GHANA_CARD_FRONT",
        mimeType: "image/jpeg",
        sizeBytes: 128,
      },
    },
  );
  assertStatus(upload, 201);
  const uploadBody = await body(upload);
  const completed = await call(
    request,
    harness.baseUrl,
    "post",
    `/v1/customer/documents/${String(uploadBody.documentId)}/complete`,
    applicantHeaders,
  );
  assertStatus(completed, 200);
  const created = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/applications",
    applicantHeaders,
  );
  assertStatus(created, 201);
  const saved = await call(
    request,
    harness.baseUrl,
    "patch",
    `/v1/customer/applications/${applicationId}/applicant`,
    {
      ...applicantHeaders,
      body: {
        expectedVersion: 1,
        mutationId: "32000000-0000-4000-8000-000000000001",
        vehicleModelId: "20000000-0000-4000-8000-000000000001",
        profile: { occupation: "Courier", residentialArea: "Dansoman" },
      },
    },
  );
  assertStatus(saved, 200);
  const savedBody = await body(saved);
  const invitation = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/applications/" + applicationId + "/guarantor-invitations",
    {
      ...applicantHeaders,
      body: {
        expectedVersion: Number(savedBody.version),
        mutationId: "33000000-0000-4000-8000-000000000001",
        guarantorPhoneE164: guarantorPhone,
      },
    },
  );
  assertStatus(invitation, 201);
  await authenticateGuarantor(request, harness);
  const guarantorHeaders = { token: harness.guarantorToken };
  const resolved = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/guarantor-invitations/resolutions",
    { ...guarantorHeaders, body: { invitationToken } },
  );
  assertStatus(resolved, 200);
  const guarantorConsent = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/consents",
    {
      ...guarantorHeaders,
      body: {
        purpose: "NIA_IDENTITY_VERIFICATION",
        documentVersion: "nia-consent-v1",
        phoneE164: guarantorPhone,
      },
    },
  );
  assertStatus(guarantorConsent, 201);
  const guarantorConsentBody = await body(guarantorConsent);
  const guarantorNia = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/identity/ghana-card-verifications",
    {
      ...guarantorHeaders,
      body: {
        consentId: guarantorConsentBody.consentId as string,
        ghanaCardNumber: "GHA-987654321-0",
        idempotencyKey: "34000000-0000-4000-8000-000000000001",
      },
    },
  );
  assertStatus(guarantorNia, 201);
  const guarantorUpload = await call(
    request,
    harness.baseUrl,
    "post",
    "/v1/customer/documents/uploads",
    {
      ...guarantorHeaders,
      body: {
        documentType: "GHANA_CARD_FRONT",
        mimeType: "image/jpeg",
        sizeBytes: 128,
      },
    },
  );
  assertStatus(guarantorUpload, 201);
  const guarantorUploadBody = await body(guarantorUpload);
  const guarantorCompleted = await call(
    request,
    harness.baseUrl,
    "post",
    `/v1/customer/documents/${String(guarantorUploadBody.documentId)}/complete`,
    guarantorHeaders,
  );
  assertStatus(guarantorCompleted, 200);
  const guarantorSaved = await call(
    request,
    harness.baseUrl,
    "patch",
    "/v1/customer/guarantor",
    {
      ...guarantorHeaders,
      body: {
        invitationToken,
        expectedVersion: Number(savedBody.version) + 1,
        mutationId: "35000000-0000-4000-8000-000000000001",
        profile: { occupation: "Mechanic", relationshipToApplicant: "Sibling" },
      },
    },
  );
  assertStatus(guarantorSaved, 200);
  const guarantorSavedBody = await body(guarantorSaved);
  const submitted = await call(
    request,
    harness.baseUrl,
    "post",
    `/v1/customer/applications/${applicationId}/submissions`,
    {
      ...applicantHeaders,
      body: {
        expectedVersion: Number(guarantorSavedBody.applicationVersion),
        mutationId: "36000000-0000-4000-8000-000000000001",
      },
    },
  );
  assertStatus(submitted, 200);
}

export async function approveAllStages(
  request: ApiRequest,
  harness: PilotHarness,
): Promise<void> {
  const stages: Array<[string, RoleKey]> = [
    ["VERIFICATION", "VERIFICATION_OFFICER"],
    ["BSM_INITIAL", "BSM"],
    ["AGM", "AGM"],
    ["CFO", "CFO"],
    ["BSM_FINAL", "BSM"],
    ["MD", "MD"],
  ];
  for (const [stage, role] of stages) {
    const result = await call(
      request,
      harness.baseUrl,
      "post",
      `/v1/staff/applications/${applicationId}/approve`,
      {
        token: harness.staffTokens[role],
        body: {
          expectedVersion: harness.state.application.version,
          stage,
          note: `Synthetic ${stage} approval`,
          idempotencyKey: `approval-${stage.toLowerCase()}`,
        },
      },
    );
    assertStatus(result, 200);
  }
}

export async function createAndAcceptOffer(
  request: ApiRequest,
  harness: PilotHarness,
): Promise<void> {
  const created = await call(
    request,
    harness.baseUrl,
    "post",
    `/v1/customer/applications/${applicationId}/offers`,
    {
      token: harness.applicantToken,
      body: {
        depositMinor: "10000",
        frequency: "MONTHLY",
        tenureMonths: 12,
        firstDueDate: "2026-09-01",
        expiresAt: "2026-08-30T12:00:00.000Z",
        idempotencyKey: "offer-create-001",
      },
    },
  );
  assertStatus(created, 201);
  const offer = await body(created);
  const accepted = await call(
    request,
    harness.baseUrl,
    "post",
    `/v1/customer/offers/${String(offer.id)}/accept`,
    {
      token: harness.applicantToken,
      body: {
        consent: true,
        expectedVersion: Number(offer.version),
        consentAt: "2026-08-23T12:00:00.000Z",
        disclosedVersion: "disclosure-v1",
        disclosedHash: "b".repeat(64),
        idempotencyKey: "offer-accept-001",
      },
    },
  );
  assertStatus(accepted, 200);
}

export async function postPayment(
  request: ApiRequest,
  harness: PilotHarness,
  event: Record<string, unknown>,
): Promise<ApiResponse> {
  const signed = harness.signPayment(event);
  return call(
    request,
    harness.baseUrl,
    "post",
    "/v1/integrations/payments/somoco",
    {
      body: JSON.parse(signed.body) as Record<string, unknown>,
      headers: signed.headers,
    },
  );
}

export function assertStatus(response: ApiResponse, expected: number): void {
  if (response.status() !== expected)
    throw new Error(`Expected HTTP ${expected}, received ${response.status()}`);
}

type RoleKey = keyof PilotHarness["staffTokens"];

export { applicantPersonId, guarantorPersonId };
