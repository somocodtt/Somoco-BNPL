import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  applicantPhone,
  startRealPilot,
  type PilotRuntime,
} from "./support/real-pilot.js";
import { body, call, completeOnboarding } from "./support/pilot-client.js";
import { createApiRequest } from "./support/vitest-http.js";

let runtime: PilotRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("controlled-pilot information request boundary", () => {
  it("returns the application to the requested stage only after public resubmission", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    const detail = await call(
      request,
      runtime.baseUrl,
      "get",
      `/v1/staff/applications/${flow.applicationId}`,
      {
        headers: runtime.staff.get("VERIFICATION_OFFICER")!.headers,
      },
    );
    expect(detail.status()).toBe(200);
    const requestInfo = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/request-information`,
      {
        headers: runtime.staff.get("VERIFICATION_OFFICER")!.headers,
        body: {
          expectedVersion: Number((await body(detail)).version),
          stage: "VERIFICATION",
          note: "Please clarify the residential area.",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(requestInfo.status()).toBe(200);
    await expect(body(requestInfo)).resolves.toMatchObject({
      action: "REQUEST_INFORMATION",
    });
    const requested = await body(requestInfo);
    const resubmitted = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/applications/${flow.applicationId}/resubmissions`,
      {
        headers: runtime.customer.applicant.headers,
        body: {
          expectedVersion: Number(requested.version),
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(resubmitted.status()).toBe(200);
    await expect(body(resubmitted)).resolves.toMatchObject({
      status: "VERIFICATION_REVIEW",
    });
  }, 60_000);

  it("records NIA outage evidence and retries through the same public identity boundary", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    const consent = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/customer/consents",
      {
        headers: runtime.customer.applicant.headers,
        body: {
          purpose: "NIA_IDENTITY_VERIFICATION",
          documentVersion: "nia-consent-v1",
          phoneE164: applicantPhone,
        },
      },
    );
    expect(consent.status()).toBe(201);
    const consentBody = await body(consent);
    runtime.controls.setNiaAvailable(false);
    const unavailable = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/customer/identity/ghana-card-verifications",
      {
        headers: runtime.customer.applicant.headers,
        body: {
          consentId: String(consentBody.consentId),
          ghanaCardNumber: "GHA-123456789-1",
          idempotencyKey: "41000000-0000-4000-8000-000000000001",
        },
      },
    );
    expect(unavailable.status(), await unavailable.text()).toBe(503);
    await expect(body(unavailable)).resolves.toMatchObject({
      code: "NIA_UNAVAILABLE",
    });
    runtime.controls.setNiaAvailable(true);
    const recovered = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/customer/identity/ghana-card-verifications",
      {
        headers: runtime.customer.applicant.headers,
        body: {
          consentId: String(consentBody.consentId),
          ghanaCardNumber: "GHA-123456789-1",
          idempotencyKey: "41000000-0000-4000-8000-000000000001",
        },
      },
    );
    expect(recovered.status()).toBe(201);
    await expect(body(recovered)).resolves.toMatchObject({
      status: "VERIFIED",
      decision: "MATCH",
    });
  }, 60_000);

  it("fails closed after three invalid OTP attempts", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    const requested = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/customer/otp/requests",
      { body: { phoneE164: applicantPhone } },
    );
    expect(requested.status()).toBe(202);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const verification = await call(
        request,
        runtime.baseUrl,
        "post",
        "/v1/customer/otp/verifications",
        { body: { phoneE164: applicantPhone, code: "000000" } },
      );
      expect(verification.status()).toBe(401);
      await expect(body(verification)).resolves.toMatchObject({
        code: "OTP_VERIFICATION_FAILED",
      });
    }
  }, 60_000);

  it("quarantines a malware-positive document through the public upload boundary", async () => {
    runtime = await startRealPilot();
    const request = createApiRequest(runtime.app);
    runtime.controls.setMalwareVerdict("INFECTED");
    const bytes = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    const upload = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/customer/documents/uploads",
      {
        headers: runtime.customer.applicant.headers,
        body: {
          documentType: "GHANA_CARD_FRONT",
          mimeType: "image/png",
          sizeBytes: bytes.byteLength,
        },
      },
    );
    expect(upload.status()).toBe(201);
    const uploadBody = await body(upload);
    runtime.uploadDocument(
      {
        uploadUrl: String(uploadBody.uploadUrl),
        requiredHeaders: (uploadBody.requiredHeaders ?? {}) as Readonly<
          Record<string, string>
        >,
      },
      bytes,
      "image/png",
    );
    const completed = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/documents/${String(uploadBody.documentId)}/complete`,
      { headers: runtime.customer.applicant.headers, body: {} },
    );
    expect(completed.status()).toBe(400);
    await expect(body(completed)).resolves.toMatchObject({
      code: "DOCUMENT_MALWARE_DETECTED",
    });
  }, 60_000);
});
