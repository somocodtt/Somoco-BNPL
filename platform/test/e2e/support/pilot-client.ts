import { randomUUID } from "node:crypto";
import type { CanonicalPaymentEvent } from "../../../packages/integrations/src/index.js";
import { deriveGuarantorInvitationToken } from "../../../packages/integrations/src/index.js";
import {
  applicantPhone,
  guarantorPhone,
  type PilotRole,
  type PilotRuntime,
} from "./real-pilot.js";

export interface ApiResponse {
  status(): number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export interface ApiRequest {
  get(url: string, options?: Record<string, unknown>): Promise<ApiResponse>;
  post(url: string, options?: Record<string, unknown>): Promise<ApiResponse>;
  patch(url: string, options?: Record<string, unknown>): Promise<ApiResponse>;
}

export interface PilotFlow {
  runtime: PilotRuntime;
  applicationId: string;
  invitationToken: string;
  applicantDocumentId: string;
  applicantDocumentHash: string;
  transferEvidenceDocumentId: string;
}

const invitationSecret = "controlled-pilot-invitation-secret-at-least-32-chars";
const pngBytes = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  ),
);
const executedContractBytes = Uint8Array.from(
  Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n",
    "utf8",
  ),
);

export function api(request: ApiRequest): ApiRequest {
  return request;
}

export async function call(
  request: ApiRequest,
  baseUrl: string,
  method: "get" | "post" | "patch",
  path: string,
  options: {
    headers?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {},
): Promise<ApiResponse> {
  const headers = {
    ...(options.body === undefined
      ? {}
      : { "content-type": "application/json" }),
    ...(options.headers ?? {}),
  };
  return request[method](`${baseUrl}${path}`, {
    headers,
    ...(options.body === undefined ? {} : { data: options.body }),
  });
}

export async function body(
  response: ApiResponse,
): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return {};
  return parsed as Record<string, unknown>;
}

export async function completeOnboarding(
  request: ApiRequest,
  runtime: PilotRuntime,
): Promise<PilotFlow> {
  const applicant = runtime.customer.applicant;
  const guarantor = runtime.customer.guarantor;
  const consent = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/consents",
    {
      headers: applicant.headers,
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
    runtime.baseUrl,
    "post",
    "/v1/customer/identity/ghana-card-verifications",
    {
      headers: applicant.headers,
      body: {
        consentId: String(consentBody.consentId),
        ghanaCardNumber: "GHA-123456789-1",
        idempotencyKey: "31000000-0000-4000-8000-000000000001",
      },
    },
  );
  assertStatus(nia, 201);
  const upload = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/documents/uploads",
    {
      headers: applicant.headers,
      body: {
        documentType: "GHANA_CARD_FRONT",
        mimeType: "image/png",
        sizeBytes: pngBytes.byteLength,
      },
    },
  );
  assertStatus(upload, 201);
  const uploadBody = await body(upload);
  runtime.uploadDocument(
    {
      uploadUrl: String(uploadBody.uploadUrl),
      requiredHeaders: (uploadBody.requiredHeaders ?? {}) as Readonly<
        Record<string, string>
      >,
    },
    pngBytes,
    "image/png",
  );
  const completed = await call(
    request,
    runtime.baseUrl,
    "post",
    `/v1/customer/documents/${String(uploadBody.documentId)}/complete`,
    { headers: applicant.headers, body: {} },
  );
  if (completed.status() !== 200)
    throw new Error(
      `DOCUMENT_COMPLETE_FAILED_${completed.status()}_${await completed.text()}`,
    );
  const executedUpload = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/documents/uploads",
    {
      headers: applicant.headers,
      body: {
        documentType: "EXECUTED_CONTRACT",
        mimeType: "application/pdf",
        sizeBytes: executedContractBytes.byteLength,
      },
    },
  );
  assertStatus(executedUpload, 201);
  const executedUploadBody = await body(executedUpload);
  runtime.uploadDocument(
    {
      uploadUrl: String(executedUploadBody.uploadUrl),
      requiredHeaders: (executedUploadBody.requiredHeaders ?? {}) as Readonly<
        Record<string, string>
      >,
    },
    executedContractBytes,
    "application/pdf",
  );
  const executedCompleted = await call(
    request,
    runtime.baseUrl,
    "post",
    `/v1/customer/documents/${String(executedUploadBody.documentId)}/complete`,
    { headers: applicant.headers, body: {} },
  );
  if (executedCompleted.status() !== 200)
    throw new Error(
      `EXECUTED_DOCUMENT_COMPLETE_FAILED_${executedCompleted.status()}_${await executedCompleted.text()}`,
    );
  const executedCompletedBody = await body(executedCompleted);
  const transferUpload = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/documents/uploads",
    {
      headers: applicant.headers,
      body: {
        documentType: "TRANSFER_EVIDENCE",
        mimeType: "application/pdf",
        sizeBytes: executedContractBytes.byteLength,
      },
    },
  );
  assertStatus(transferUpload, 201);
  const transferUploadBody = await body(transferUpload);
  runtime.uploadDocument(
    {
      uploadUrl: String(transferUploadBody.uploadUrl),
      requiredHeaders: (transferUploadBody.requiredHeaders ?? {}) as Readonly<
        Record<string, string>
      >,
    },
    executedContractBytes,
    "application/pdf",
  );
  const transferCompleted = await call(
    request,
    runtime.baseUrl,
    "post",
    `/v1/customer/documents/${String(transferUploadBody.documentId)}/complete`,
    { headers: applicant.headers, body: {} },
  );
  if (transferCompleted.status() !== 200)
    throw new Error(
      `TRANSFER_DOCUMENT_COMPLETE_FAILED_${transferCompleted.status()}_${await transferCompleted.text()}`,
    );
  const created = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/applications",
    { headers: applicant.headers, body: {} },
  );
  if (created.status() !== 201)
    throw new Error(
      `APPLICATION_CREATE_FAILED_${created.status()}_${await created.text()}`,
    );
  const applicationId = String((await body(created)).id);
  const saved = await call(
    request,
    runtime.baseUrl,
    "patch",
    `/v1/customer/applications/${applicationId}/applicant`,
    {
      headers: applicant.headers,
      body: {
        expectedVersion: 1,
        mutationId: "32000000-0000-4000-8000-000000000001",
        productId: runtime.productId,
        vehicleModelId: runtime.applicationFixtures.vehicleModelId,
        profile: { occupation: "Courier", residentialArea: "Dansoman" },
      },
    },
  );
  assertStatus(saved, 200);
  const savedBody = await body(saved);
  const invitation = await call(
    request,
    runtime.baseUrl,
    "post",
    `/v1/customer/applications/${applicationId}/guarantor-invitations`,
    {
      headers: applicant.headers,
      body: {
        expectedVersion: Number(savedBody.version),
        mutationId: "33000000-0000-4000-8000-000000000001",
        guarantorPhoneE164: guarantorPhone,
      },
    },
  );
  assertStatus(invitation, 201);
  const invitationBody = await body(invitation);
  const invitationToken = deriveGuarantorInvitationToken(
    invitationSecret,
    String(invitationBody.invitationId),
    1,
  );
  const resolved = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/guarantor-invitations/resolutions",
    {
      headers: guarantor.headers,
      body: { invitationToken },
    },
  );
  assertStatus(resolved, 200);
  const resolvedBody = await body(resolved);
  const guarantorConsent = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/consents",
    {
      headers: guarantor.headers,
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
    runtime.baseUrl,
    "post",
    "/v1/customer/identity/ghana-card-verifications",
    {
      headers: guarantor.headers,
      body: {
        consentId: String(guarantorConsentBody.consentId),
        ghanaCardNumber: "GHA-987654321-0",
        idempotencyKey: "34000000-0000-4000-8000-000000000001",
      },
    },
  );
  assertStatus(guarantorNia, 201);
  const guarantorUpload = await call(
    request,
    runtime.baseUrl,
    "post",
    "/v1/customer/documents/uploads",
    {
      headers: guarantor.headers,
      body: {
        documentType: "GHANA_CARD_FRONT",
        mimeType: "image/png",
        sizeBytes: pngBytes.byteLength,
      },
    },
  );
  assertStatus(guarantorUpload, 201);
  const guarantorUploadBody = await body(guarantorUpload);
  runtime.uploadDocument(
    {
      uploadUrl: String(guarantorUploadBody.uploadUrl),
      requiredHeaders: (guarantorUploadBody.requiredHeaders ?? {}) as Readonly<
        Record<string, string>
      >,
    },
    pngBytes,
    "image/png",
  );
  const guarantorCompleted = await call(
    request,
    runtime.baseUrl,
    "post",
    `/v1/customer/documents/${String(guarantorUploadBody.documentId)}/complete`,
    { headers: guarantor.headers, body: {} },
  );
  if (guarantorCompleted.status() !== 200)
    throw new Error(
      `GUARANTOR_DOCUMENT_COMPLETE_FAILED_${guarantorCompleted.status()}_${await guarantorCompleted.text()}`,
    );
  const currentVersion = Number(resolvedBody.relationshipVersion);
  const guarantorSaved = await call(
    request,
    runtime.baseUrl,
    "patch",
    "/v1/customer/guarantor",
    {
      headers: guarantor.headers,
      body: {
        invitationToken,
        expectedVersion: currentVersion,
        mutationId: "35000000-0000-4000-8000-000000000001",
        profile: { occupation: "Mechanic", relationshipToApplicant: "Sibling" },
      },
    },
  );
  if (guarantorSaved.status() !== 200)
    throw new Error(
      `GUARANTOR_SAVE_FAILED_${guarantorSaved.status()}_saved_${String(savedBody.version)}_resolved_${String(invitationBody.applicationVersion)}_expected_${String(currentVersion)}_${await guarantorSaved.text()}`,
    );
  const guarantorSavedBody = await body(guarantorSaved);
  const submitted = await call(
    request,
    runtime.baseUrl,
    "post",
    `/v1/customer/applications/${applicationId}/submissions`,
    {
      headers: applicant.headers,
      body: {
        expectedVersion: Number(guarantorSavedBody.applicationVersion),
        mutationId: "36000000-0000-4000-8000-000000000001",
      },
    },
  );
  assertStatus(submitted, 200);
  return {
    runtime,
    applicationId,
    invitationToken,
    applicantDocumentId: String(executedUploadBody.documentId),
    applicantDocumentHash: String(executedCompletedBody.sha256),
    transferEvidenceDocumentId: String(transferUploadBody.documentId),
  };
}

export async function approveAllStages(
  request: ApiRequest,
  flow: PilotFlow,
): Promise<void> {
  const stages: Array<[string, PilotRole]> = [
    ["VERIFICATION", "VERIFICATION_OFFICER"],
    ["BSM_INITIAL", "BSM"],
    ["AGM", "AGM"],
    ["CFO", "CFO"],
    ["BSM_FINAL", "BSM"],
    ["MD", "MD"],
  ];
  let version = await currentApplicationVersion(request, flow);
  for (const [stage, role] of stages) {
    const result = await call(
      request,
      flow.runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/approve`,
      {
        headers: flow.runtime.staff.get(role)!.headers,
        body: {
          expectedVersion: version,
          stage,
          note: `Controlled pilot ${stage} approval`,
          idempotencyKey: randomUUID(),
        },
      },
    );
    assertStatus(result, 200);
    version = Number((await body(result)).version);
  }
}

export async function createAndAcceptOffer(
  request: ApiRequest,
  flow: PilotFlow,
): Promise<Record<string, unknown>> {
  const created = await call(
    request,
    flow.runtime.baseUrl,
    "post",
    `/v1/customer/applications/${flow.applicationId}/offers`,
    {
      headers: flow.runtime.customer.applicant.headers,
      body: {
        depositMinor: "10000",
        frequency: "MONTHLY",
        tenureMonths: 6,
        firstDueDate: "2026-09-15",
        expiresAt: "2026-09-30T00:00:00.000Z",
        idempotencyKey: "offer-create-001",
      },
    },
  );
  if (created.status() !== 201)
    throw new Error(
      `OFFER_CREATE_FAILED_${created.status()}_${await created.text()}`,
    );
  const offer = await body(created);
  const terms = (offer.terms ?? {}) as Record<string, unknown>;
  const accepted = await call(
    request,
    flow.runtime.baseUrl,
    "post",
    `/v1/customer/offers/${String(offer.id)}/accept`,
    {
      headers: flow.runtime.customer.applicant.headers,
      body: {
        consent: true,
        expectedVersion: Number(offer.version),
        consentAt: "2026-08-01T12:00:00.000Z",
        disclosedVersion: String(offer.disclosedVersion),
        disclosedHash: String(offer.disclosedHash ?? terms.disclosureHash),
        idempotencyKey: "offer-accept-001",
      },
    },
  );
  assertStatus(accepted, 200);
  return body(accepted);
}

export async function prepareContractWithoutSignatures(
  request: ApiRequest,
  flow: PilotFlow,
): Promise<{ contractId: string; contractVersion: number }> {
  await approveAllStages(request, flow);
  await createAndAcceptOffer(request, flow);
  const depositEvent: CanonicalPaymentEvent = {
    eventId: `controlled-pilot-signature-gate-deposit-${randomUUID()}`,
    eventType: "PAYMENT_SUCCEEDED",
    channel: "MOBILE_MONEY",
    providerTransactionId: `controlled-pilot-signature-gate-provider-${randomUUID()}`,
    payerPhoneE164: applicantPhone,
    customerReference: flow.applicationId,
    amount: { currency: "GHS", minorUnits: "10000" },
    occurredAt: "2026-08-02T12:10:00.000Z",
  };
  const deposit = await postPayment(request, flow, depositEvent);
  assertStatus(deposit, 202);
  const suffix = randomUUID().slice(0, 8).toUpperCase();
  const vehicle = await call(
    request,
    flow.runtime.baseUrl,
    "post",
    "/v1/staff/assets",
    {
      headers: flow.runtime.staff.get("INVENTORY_OFFICER")!.headers,
      body: {
        vehicleModelId: flow.runtime.applicationFixtures.vehicleModelId,
        vin: `CONTROLLED-PILOT-SIG-VIN-${suffix}`,
        chassisNumber: `CONTROLLED-PILOT-SIG-CHASSIS-${suffix}`,
        engineMotorIdentifier: `CONTROLLED-PILOT-SIG-ENGINE-${suffix}`,
        condition: { state: "NEW" },
        accessories: ["helmet"],
        idempotencyKey: `pilot-signature-gate-vehicle-${suffix}`,
      },
    },
  );
  assertStatus(vehicle, 201);
  const vehicleBody = await body(vehicle);
  const vehicleId = String(vehicleBody.id);
  let vehicleVersion = Number(vehicleBody.version);
  const registration = await call(
    request,
    flow.runtime.baseUrl,
    "post",
    `/v1/staff/assets/${vehicleId}/registration`,
    {
      headers: flow.runtime.staff.get("INVENTORY_OFFICER")!.headers,
      body: {
        registrationNumber: `GT-SIG-${suffix}`,
        validFrom: "2026-08-01",
        validTo: "2027-08-01",
        expectedVehicleVersion: vehicleVersion,
        idempotencyKey: `pilot-signature-gate-registration-${suffix}`,
      },
    },
  );
  assertStatus(registration, 200);
  vehicleVersion = Number((await body(registration)).version);
  const insurance = await call(
    request,
    flow.runtime.baseUrl,
    "post",
    `/v1/staff/assets/${vehicleId}/insurance`,
    {
      headers: flow.runtime.staff.get("INVENTORY_OFFICER")!.headers,
      body: {
        policyNumber: `CONTROLLED-PILOT-SIG-POLICY-${suffix}`,
        provider: "Controlled Pilot Insurer",
        validFrom: "2026-08-01",
        validTo: "2027-08-01",
        expectedVehicleVersion: vehicleVersion,
        idempotencyKey: `pilot-signature-gate-insurance-${suffix}`,
      },
    },
  );
  assertStatus(insurance, 200);
  vehicleVersion = Number((await body(insurance)).version);
  const assignment = await call(
    request,
    flow.runtime.baseUrl,
    "post",
    `/v1/staff/applications/${flow.applicationId}/asset-assignment`,
    {
      headers: flow.runtime.staff.get("INVENTORY_OFFICER")!.headers,
      body: {
        vehicleUnitId: vehicleId,
        expectedVehicleVersion: vehicleVersion,
        idempotencyKey: `pilot-signature-gate-assignment-${suffix}`,
      },
    },
  );
  assertStatus(assignment, 200);
  const assignmentBody = await body(assignment);
  const generated = await call(
    request,
    flow.runtime.baseUrl,
    "post",
    `/v1/staff/applications/${flow.applicationId}/contracts`,
    {
      headers: flow.runtime.staff.get("INVENTORY_OFFICER")!.headers,
      body: {
        assignmentId: String(assignmentBody.id),
        idempotencyKey: `pilot-signature-gate-contract-${suffix}`,
      },
    },
  );
  assertStatus(generated, 201);
  const contract = await body(generated);
  return {
    contractId: String(contract.id),
    contractVersion: Number(contract.version),
  };
}

export async function postPayment(
  request: ApiRequest,
  flow: PilotFlow,
  event: CanonicalPaymentEvent,
): Promise<ApiResponse> {
  const rawBody = Uint8Array.from(Buffer.from(JSON.stringify(event)));
  const signature = `controlled-pilot-${event.eventId}`;
  const requestTimestamp = event.occurredAt;
  flow.runtime.addPaymentFixture({
    rawBody,
    signature,
    requestTimestamp,
    event,
  });
  return call(
    request,
    flow.runtime.baseUrl,
    "post",
    "/v1/integrations/payments/somoco",
    {
      headers: {
        "content-type": "application/json",
        "x-payment-signature": signature,
        "x-payment-timestamp": requestTimestamp,
      },
      body: event as unknown as Record<string, unknown>,
    },
  );
}

export async function currentApplicationVersion(
  request: ApiRequest,
  flow: PilotFlow,
): Promise<number> {
  const response = await call(
    request,
    flow.runtime.baseUrl,
    "get",
    `/v1/staff/applications/${flow.applicationId}`,
    { headers: flow.runtime.staff.get("VERIFICATION_OFFICER")!.headers },
  );
  assertStatus(response, 200);
  return Number((await body(response)).version);
}

export function assertStatus(response: ApiResponse, expected: number): void {
  if (response.status() !== expected)
    throw new Error(`Expected HTTP ${expected}, received ${response.status()}`);
}
