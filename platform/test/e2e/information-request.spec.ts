import {
  expect,
  test,
} from "../../apps/customer-web/node_modules/@playwright/test/index.mjs";
import {
  applicantPhone,
  applicationId,
  otpCode,
  startPilotHarness,
} from "./support/pilot-harness.js";
import {
  api,
  assertStatus,
  body,
  call,
  completeOnboarding,
} from "./support/pilot-client.js";

test("information requests return to the same approval stage only after customer resubmission", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    const client = api(request);
    await completeOnboarding(client, harness);
    const requested = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/applications/${applicationId}/request-information`,
      {
        token: harness.staffTokens.VERIFICATION_OFFICER,
        body: {
          expectedVersion: harness.state.application.version,
          stage: "VERIFICATION",
          note: "Please clarify the residential area.",
          idempotencyKey: "info-request-001",
        },
      },
    );
    assertStatus(requested, 200);
    expect((await body(requested)).status).toBe("INFORMATION_REQUESTED");

    const resubmitted = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/customer/applications/${applicationId}/resubmissions`,
      {
        token: harness.applicantToken,
        body: {
          expectedVersion: harness.state.application.version,
          idempotencyKey: "resubmission-001",
        },
      },
    );
    assertStatus(resubmitted, 200);
    expect((await body(resubmitted)).status).toBe("VERIFICATION_REVIEW");
  } finally {
    await harness.close();
  }
});

test("NIA outage and malware rejection fail closed at their provider boundaries", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    const client = api(request);
    const otpRequest = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/otp/requests",
      { body: { phoneE164: applicantPhone } },
    );
    assertStatus(otpRequest, 202);
    const verified = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/otp/verifications",
      { body: { phoneE164: applicantPhone, code: otpCode } },
    );
    assertStatus(verified, 201);
    harness.setNiaOutage(true);
    const unavailable = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/consents",
      {
        token: harness.applicantToken,
        body: {
          purpose: "NIA_IDENTITY_VERIFICATION",
          documentVersion: "nia-consent-v1",
          phoneE164: applicantPhone,
        },
      },
    );
    assertStatus(unavailable, 503);
    expect((await body(unavailable)).code).toBe("NIA_UNAVAILABLE");
    harness.setNiaOutage(false);
    const consent = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/consents",
      {
        token: harness.applicantToken,
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
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/identity/ghana-card-verifications",
      {
        token: harness.applicantToken,
        body: {
          consentId: String(consentBody.consentId),
          ghanaCardNumber: "GHA-123456789-1",
          idempotencyKey: "nia-recovery-001",
        },
      },
    );
    assertStatus(nia, 201);
    const malware = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/documents/uploads",
      {
        token: harness.applicantToken,
        body: {
          documentType: "GHANA_CARD_FRONT",
          mimeType: "application/x-msdownload",
          sizeBytes: 128,
        },
      },
    );
    assertStatus(malware, 422);
    expect((await body(malware)).code).toBe("MALWARE_REJECTED");
  } finally {
    await harness.close();
  }
});

test("OTP request and verification abuse stay rate-limited", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    const client = api(request);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await call(
        client,
        harness.baseUrl,
        "post",
        "/v1/customer/otp/requests",
        { body: { phoneE164: applicantPhone } },
      );
      assertStatus(response, 202);
    }
    const fourthRequest = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/otp/requests",
      { body: { phoneE164: applicantPhone } },
    );
    assertStatus(fourthRequest, 429);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await call(
        client,
        harness.baseUrl,
        "post",
        "/v1/customer/otp/verifications",
        { body: { phoneE164: applicantPhone, code: "000000" } },
      );
      assertStatus(response, 401);
    }
    const locked = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/customer/otp/verifications",
      { body: { phoneE164: applicantPhone, code: "000000" } },
    );
    assertStatus(locked, 429);
  } finally {
    await harness.close();
  }
});
