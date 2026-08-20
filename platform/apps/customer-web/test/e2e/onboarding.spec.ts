import { createHmac } from "node:crypto";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";

const applicationId = "10000000-0000-4000-8000-000000000001";
const vehicleModelId = "20000000-0000-4000-8000-000000000001";
const invitationId = "50000000-0000-4000-8000-000000000001";
const applicantPhone = "+233241000001";
const guarantorPhone = "+233241000002";
const invitationSecret = "task-7-playwright-fixture-secret-at-least-32-chars";

test("applicant and guarantor complete onboarding in independent contexts before submission", async ({
  browser,
}) => {
  const fixture = onboardingFixture();
  const applicantContext = await browser.newContext();
  const guarantorContext = await browser.newContext();
  await installApi(applicantContext, fixture);
  await installApi(guarantorContext, fixture);
  const applicant = await applicantContext.newPage();
  const guarantor = await guarantorContext.newPage();

  try {
    await applicant.goto("/");
    await signIn(applicant, applicantPhone, fixture);
    await applicant.getByLabel("Vehicle model").selectOption(vehicleModelId);
    await applicant.getByLabel("Occupation").fill("Courier");
    await applicant.getByLabel("Residential area").fill("Dansoman");
    await completeEvidence(applicant, "GHA-123456789-1", "applicant-card.png");
    await applicant.getByRole("button", { name: "Save and continue" }).click();
    await expect(applicant.getByText("Draft saved")).toBeVisible();

    await applicant.getByLabel("Guarantor mobile number").fill(guarantorPhone);
    const invitationResponse = applicant.waitForResponse((response) =>
      response
        .url()
        .endsWith(`/applications/${applicationId}/guarantor-invitations`),
    );
    await applicant.getByRole("button", { name: "Send invitation" }).click();
    const invitation = await (await invitationResponse).json();
    expect(invitation).toMatchObject({
      invitationId,
      applicationVersion: 3,
      relationshipVersion: 1,
    });
    expect(invitation).not.toHaveProperty("token");
    expect(fixture.deliveredInvitationToken).toBe(
      deriveInvitationToken(invitationId),
    );
    expect(fixture.delivery).toEqual({
      targetPhone: guarantorPhone,
      fragmentOnly: true,
    });
    await expect(
      applicant.getByRole("button", { name: "Submit application" }),
    ).toHaveCount(0);

    const deliveredToken = fixture.deliveredInvitationToken!;
    await guarantor.goto(`/#invitation=${deliveredToken}`);
    await expect.poll(() => new URL(guarantor.url()).hash).toBe("");
    expect(guarantor.url()).not.toContain(deliveredToken);
    const resolutionResponse = guarantor.waitForResponse((response) =>
      response.url().endsWith("/guarantor-invitations/resolutions"),
    );
    await signIn(guarantor, guarantorPhone, fixture);
    const resolution = await (await resolutionResponse).json();
    expect(resolution).toMatchObject({
      status: "INVITED",
      applicationVersion: 3,
      relationshipVersion: 1,
    });
    await expect(
      guarantor.getByRole("heading", {
        name: "Complete your guarantor details",
      }),
    ).toBeVisible();
    await expect(guarantor.getByLabel("Vehicle model")).toHaveCount(0);
    await expect(guarantor.getByLabel("Residential area")).toHaveCount(0);
    await completeEvidence(guarantor, "GHA-987654321-0", "guarantor-card.png");
    await guarantor.getByLabel("Occupation").fill("Mechanic");
    await guarantor.getByLabel("Relationship to applicant").fill("Sibling");
    const guarantorSaveResponse = guarantor.waitForResponse((response) =>
      response.url().endsWith("/v1/customer/guarantor"),
    );
    await guarantor
      .getByRole("button", { name: "Save guarantor details" })
      .click();
    const guarantorSave = await (await guarantorSaveResponse).json();
    expect(guarantorSave).toMatchObject({
      applicationVersion: 4,
      relationshipVersion: 2,
      status: "CONFIRMED",
    });
    await expect(
      guarantor.getByText("Your details were sent securely."),
    ).toBeVisible();

    expect(fixture.resolvedInvitation).toBe(true);
    expect(fixture.invitationTargetPhone).toBe(guarantorPhone);
    expect(fixture.resolutionPhone).toBe(guarantorPhone);
    expect(fixture.guarantorSavePhone).toBe(guarantorPhone);
    expect(fixture.guarantorSaveRelationshipVersion).toBe(1);
    expect(fixture.sessionTokens.get(applicantPhone)).not.toBe(
      fixture.sessionTokens.get(guarantorPhone),
    );
    expect(fixture.evidence.applicant).toMatchObject({
      phone: applicantPhone,
      consented: true,
      identityVerified: true,
      documentAccepted: true,
    });
    expect(fixture.evidence.guarantor).toMatchObject({
      phone: guarantorPhone,
      consented: true,
      identityVerified: true,
      documentAccepted: true,
    });

    await applicant.reload();
    await signIn(applicant, applicantPhone, fixture);
    await expect(
      applicant.getByRole("button", { name: "Submit application" }),
    ).toBeVisible();
    expect(fixture.applicationVersion).toBe(4);
    const submitResponse = applicant.waitForResponse((response) =>
      response.url().endsWith(`/applications/${applicationId}/submissions`),
    );
    await applicant.getByRole("button", { name: "Submit application" }).click();
    const submitted = await (await submitResponse).json();
    expect(submitted).toMatchObject({
      id: applicationId,
      status: "VERIFICATION_REVIEW",
      version: 5,
    });
    await expect(
      applicant.getByText("Your application is in verification review."),
    ).toBeVisible();
    await expect(
      applicant
        .getByRole("list", { name: "Application status" })
        .getByText("Verification review"),
    ).toHaveAttribute("aria-current", "step");
    expect(fixture.submitObservedReady).toBe(true);
  } finally {
    await applicantContext.close();
    await guarantorContext.close();
  }
});

async function signIn(page: Page, phone: string, state: FixtureState) {
  const priorRequests = state.otpRequests;
  await page.getByLabel("Mobile number").fill(phone);
  const observedRequest = page.waitForRequest((request) =>
    request.url().endsWith("/v1/customer/otp/requests"),
  );
  const observedResponse = page.waitForResponse((response) =>
    response.url().endsWith("/v1/customer/otp/requests"),
  );
  await page.getByRole("button", { name: "Send code" }).click();
  const request = await observedRequest;
  const response = await observedResponse;
  expect(response.status()).toBe(202);
  await expect
    .poll(
      () => state.otpRequests,
      `observed browser request ${request.method()} ${request.url()} but fixture did not intercept it`,
    )
    .toBe(priorRequests + 1);
  await expect(page.getByLabel("Verification code")).toBeVisible();
  await page.getByLabel("Verification code").fill("619204");
  await page.getByRole("button", { name: "Continue" }).click();
}

interface EvidenceState {
  phone: string;
  consented: boolean;
  identityVerified: boolean;
  documentAccepted: boolean;
}

interface FixtureState {
  status:
    "DRAFT" | "AWAITING_GUARANTOR" | "READY_TO_SUBMIT" | "VERIFICATION_REVIEW";
  applicationVersion: number;
  vehicleModelId: string | null;
  applicantProfile: Record<string, unknown>;
  guarantorProfile: Record<string, unknown>;
  guarantorDone: boolean;
  otpRequests: number;
  otpRequestedPhones: string[];
  deliveredInvitationToken: string | null;
  delivery: { targetPhone: string; fragmentOnly: boolean } | null;
  invitationTargetPhone: string | null;
  invitationExpiresAt: string | null;
  relationshipVersion: number | null;
  resolvedInvitation: boolean;
  resolutionPhone: string | null;
  guarantorSavePhone: string | null;
  guarantorSaveRelationshipVersion: number | null;
  submitObservedReady: boolean;
  sessionTokens: Map<string, string>;
  sessionsByToken: Map<string, string>;
  evidence: { applicant: EvidenceState; guarantor: EvidenceState };
  documentTickets: Map<string, "applicant" | "guarantor">;
  requestActors: Array<{ method: string; path: string; phone: string }>;
}

function onboardingFixture(): FixtureState {
  return {
    status: "DRAFT",
    applicationVersion: 1,
    vehicleModelId: null,
    applicantProfile: {},
    guarantorProfile: {},
    guarantorDone: false,
    otpRequests: 0,
    otpRequestedPhones: [],
    deliveredInvitationToken: null,
    delivery: null,
    invitationTargetPhone: null,
    invitationExpiresAt: null,
    relationshipVersion: null,
    resolvedInvitation: false,
    resolutionPhone: null,
    guarantorSavePhone: null,
    guarantorSaveRelationshipVersion: null,
    submitObservedReady: false,
    sessionTokens: new Map(),
    sessionsByToken: new Map(),
    evidence: {
      applicant: evidenceFor(applicantPhone),
      guarantor: evidenceFor(guarantorPhone),
    },
    documentTickets: new Map(),
    requestActors: [],
  };
}

function evidenceFor(phone: string): EvidenceState {
  return {
    phone,
    consented: false,
    identityVerified: false,
    documentAccepted: false,
  };
}

async function completeEvidence(
  page: Page,
  ghanaCardNumber: string,
  fileName: string,
) {
  await page
    .getByRole("checkbox", { name: "I agree to identity verification" })
    .check();
  await page.getByLabel("Ghana Card number").fill(ghanaCardNumber);
  await page.getByRole("button", { name: "Verify identity" }).click();
  await expect(page.getByText("Identity verified")).toBeVisible();
  await page.getByLabel("GHANA_CARD_FRONT evidence").setInputFiles({
    name: fileName,
    mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ),
  });
  await expect(page.getByText("GHANA_CARD_FRONT accepted")).toBeVisible();
}

async function installApi(context: BrowserContext, state: FixtureState) {
  await context.route("**/v1/customer/**", async (route) =>
    respond(route, state),
  );
  await context.route("https://objects.test/**", async (route) =>
    route.fulfill({ status: 200, body: "" }),
  );
}

async function respond(route: Route, state: FixtureState) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  const body = readBody(request);

  try {
    if (path.endsWith("/otp/requests")) {
      const phone = requirePhone(body.phoneE164);
      requireActorPhone(phone);
      state.otpRequests += 1;
      state.otpRequestedPhones.push(phone);
      return fulfill(route, 202, {});
    }
    if (path.endsWith("/otp/verifications")) {
      const phone = requirePhone(body.phoneE164);
      requireActorPhone(phone);
      if (body.code !== "619204" || !state.otpRequestedPhones.includes(phone)) {
        throw new FixtureHttpError(401, "OTP_INVALID", "Code is invalid.");
      }
      const token = createHmac("sha256", "task-7-session-fixture-secret")
        .update(`${phone}:${state.otpRequests}`)
        .digest("base64url");
      state.sessionTokens.set(phone, token);
      state.sessionsByToken.set(token, phone);
      return fulfill(route, 200, {
        sessionToken: token,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }

    const phone = authenticatedPhone(request, state);
    state.requestActors.push({ method, path, phone });

    if (path.endsWith("/vehicle-models")) {
      requireApplicant(phone);
      return fulfill(route, 200, [
        {
          id: vehicleModelId,
          manufacturer: "Synthetic Motors",
          modelName: "Pilot Bike",
          modelYear: 2026,
        },
      ]);
    }
    if (path.endsWith("/applications/resume")) {
      requireApplicant(phone);
      return fulfill(route, 200, resume(state));
    }
    if (path.endsWith("/applications") && method === "POST") {
      requireApplicant(phone);
      return fulfill(route, 201, draft(state));
    }
    if (path.endsWith("/completeness")) {
      requireApplicant(phone);
      return fulfill(route, 200, completeness(state));
    }
    if (path.endsWith("/consents") && method === "POST") {
      requirePhoneMatches(body.phoneE164, phone);
      const actor = actorForPhone(phone);
      state.evidence[actor].consented = true;
      return fulfill(route, 201, {
        consentId:
          actor === "applicant"
            ? "30000000-0000-4000-8000-000000000001"
            : "30000000-0000-4000-8000-000000000002",
      });
    }
    if (
      path.endsWith("/identity/ghana-card-verifications") &&
      method === "POST"
    ) {
      const actor = actorForPhone(phone);
      if (!state.evidence[actor].consented) {
        throw new FixtureHttpError(
          409,
          "CONSENT_REQUIRED",
          "Consent required.",
        );
      }
      state.evidence[actor].identityVerified = true;
      return fulfill(route, 200, { status: "VERIFIED" });
    }
    if (path.endsWith("/documents/uploads") && method === "POST") {
      const actor = actorForPhone(phone);
      if (!state.evidence[actor].identityVerified) {
        throw new FixtureHttpError(
          409,
          "NIA_REQUIRED",
          "Identity is required.",
        );
      }
      const documentId =
        actor === "applicant"
          ? "40000000-0000-4000-8000-000000000001"
          : "40000000-0000-4000-8000-000000000002";
      state.documentTickets.set(documentId, actor);
      return fulfill(route, 201, {
        documentId,
        uploadUrl: `https://objects.test/${documentId}`,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        requiredHeaders: { "content-type": "image/jpeg" },
      });
    }
    if (path.match(/\/documents\/[^/]+\/complete$/) && method === "POST") {
      const documentId = path.split("/").at(-2)!;
      const actor = actorForPhone(phone);
      if (state.documentTickets.get(documentId) !== actor) {
        throw new FixtureHttpError(
          404,
          "DOCUMENT_NOT_FOUND",
          "Document not found.",
        );
      }
      state.evidence[actor].documentAccepted = true;
      return fulfill(route, 200, {
        documentId,
        status: "ACCEPTED",
        sha256: "a".repeat(64),
      });
    }
    if (path.endsWith("/applicant") && method === "PATCH") {
      requireApplicant(phone);
      requireVersion(body.expectedVersion, state.applicationVersion);
      const evidence = state.evidence.applicant;
      if (!evidence.identityVerified || !evidence.documentAccepted) {
        throw new FixtureHttpError(
          409,
          "APPLICANT_INCOMPLETE",
          "Evidence required.",
        );
      }
      state.vehicleModelId = String(body.vehicleModelId);
      state.applicantProfile = (body.profile ?? {}) as Record<string, unknown>;
      state.applicationVersion += 1;
      return fulfill(route, 200, draft(state));
    }
    if (path.endsWith("/guarantor-invitations") && method === "POST") {
      requireApplicant(phone);
      requireVersion(body.expectedVersion, state.applicationVersion);
      if (body.guarantorPhoneE164 !== guarantorPhone) {
        throw new FixtureHttpError(
          409,
          "INVITATION_TARGET_INVALID",
          "Target mismatch.",
        );
      }
      state.invitationTargetPhone = body.guarantorPhoneE164;
      state.relationshipVersion = (state.relationshipVersion ?? 0) + 1;
      state.invitationExpiresAt = new Date(
        Date.now() + 1_800_000,
      ).toISOString();
      state.deliveredInvitationToken = deriveInvitationToken(invitationId);
      state.delivery = {
        targetPhone: body.guarantorPhoneE164,
        fragmentOnly: true,
      };
      state.applicationVersion += 1;
      state.status = "AWAITING_GUARANTOR";
      return fulfill(route, 201, {
        invitationId,
        applicationVersion: state.applicationVersion,
        relationshipVersion: state.relationshipVersion,
        expiresAt: state.invitationExpiresAt,
      });
    }
    if (
      path.endsWith("/guarantor-invitations/resolutions") &&
      method === "POST"
    ) {
      requireGuarantor(phone);
      requireInvitation(body.invitationToken, state);
      state.resolvedInvitation = true;
      state.resolutionPhone = phone;
      return fulfill(route, 200, {
        status: "INVITED",
        relationshipVersion: state.relationshipVersion,
        applicationVersion: state.applicationVersion,
        expiresAt: state.invitationExpiresAt,
      });
    }
    if (path.endsWith("/guarantor") && method === "PATCH") {
      requireGuarantor(phone);
      requireInvitation(body.invitationToken, state);
      requireVersion(body.expectedVersion, state.relationshipVersion!);
      const evidence = state.evidence.guarantor;
      if (!evidence.identityVerified || !evidence.documentAccepted) {
        throw new FixtureHttpError(
          409,
          "GUARANTOR_INCOMPLETE",
          "Evidence required.",
        );
      }
      state.guarantorSavePhone = phone;
      state.guarantorSaveRelationshipVersion = body.expectedVersion as number;
      state.guarantorProfile = (body.profile ?? {}) as Record<string, unknown>;
      state.guarantorDone = true;
      state.relationshipVersion = state.relationshipVersion! + 1;
      state.applicationVersion += 1;
      state.status = "READY_TO_SUBMIT";
      return fulfill(route, 200, {
        relationshipVersion: state.relationshipVersion,
        applicationVersion: state.applicationVersion,
        status: "CONFIRMED",
      });
    }
    if (path.endsWith("/submissions") && method === "POST") {
      requireApplicant(phone);
      requireVersion(body.expectedVersion, state.applicationVersion);
      const ready = completeness(state).ready;
      if (!ready) {
        throw new FixtureHttpError(
          409,
          "GUARANTOR_INCOMPLETE",
          "Complete all evidence first.",
        );
      }
      state.submitObservedReady = true;
      state.status = "VERIFICATION_REVIEW";
      state.applicationVersion += 1;
      return fulfill(route, 200, draft(state));
    }
    throw new FixtureHttpError(
      404,
      "NOT_FOUND",
      `Fixture route not found: ${method} ${path}`,
    );
  } catch (error) {
    if (error instanceof FixtureHttpError) {
      return fulfill(route, error.status, {
        code: error.code,
        detail: error.detail,
      });
    }
    throw error;
  }
}

type FixtureBody = Record<string, unknown>;

function readBody(request: ReturnType<Route["request"]>): FixtureBody {
  try {
    const parsed = request.postDataJSON();
    if (parsed !== null && typeof parsed === "object") {
      return parsed as FixtureBody;
    }
  } catch {
    // GET and object-upload requests do not have JSON bodies.
  }
  const raw = request.postData();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as FixtureBody;
  } catch {
    return {};
  }
}

function authenticatedPhone(
  request: ReturnType<Route["request"]>,
  state: FixtureState,
): string {
  const authorization = request.headers().authorization;
  const token = authorization?.replace(/^Bearer\s+/, "");
  const phone = token ? state.sessionsByToken.get(token) : undefined;
  if (phone === undefined) {
    throw new FixtureHttpError(
      401,
      "CUSTOMER_SESSION_REQUIRED",
      "Sign in required.",
    );
  }
  return phone;
}

function requireActorPhone(phone: string): void {
  if (phone !== applicantPhone && phone !== guarantorPhone) {
    throw new FixtureHttpError(400, "PHONE_INVALID", "Unknown fixture actor.");
  }
}

function requireApplicant(phone: string): void {
  if (phone !== applicantPhone) {
    throw new FixtureHttpError(
      403,
      "APPLICATION_FORBIDDEN",
      "Applicant access required.",
    );
  }
}

function requireGuarantor(phone: string): void {
  if (phone !== guarantorPhone) {
    throw new FixtureHttpError(
      403,
      "GUARANTOR_FORBIDDEN",
      "Guarantor access required.",
    );
  }
}

function requirePhone(phone: unknown): string {
  if (typeof phone !== "string") {
    throw new FixtureHttpError(400, "PHONE_INVALID", "Phone is required.");
  }
  return phone;
}

function requirePhoneMatches(value: unknown, expected: string): void {
  if (value !== expected) {
    throw new FixtureHttpError(
      403,
      "PHONE_MISMATCH",
      "Phone does not match session.",
    );
  }
}

function requireVersion(actual: unknown, expected: number): void {
  if (actual !== expected) {
    throw new FixtureHttpError(409, "VERSION_CONFLICT", "Version changed.");
  }
}

function requireInvitation(token: unknown, state: FixtureState): void {
  if (token !== state.deliveredInvitationToken) {
    throw new FixtureHttpError(
      404,
      "INVITATION_NOT_FOUND",
      "Invitation not found.",
    );
  }
}

function actorForPhone(phone: string): "applicant" | "guarantor" {
  requireActorPhone(phone);
  return phone === applicantPhone ? "applicant" : "guarantor";
}

function resume(state: FixtureState) {
  return {
    draft: draft(state),
    guarantorStatus: invitationStatus(state),
    guarantorInvitation: {
      status: invitationStatus(state),
      relationshipVersion: state.relationshipVersion,
      expiresAt: state.invitationExpiresAt,
    },
  };
}

function invitationStatus(state: FixtureState) {
  if (state.status === "DRAFT") return "NOT_INVITED" as const;
  if (state.status === "AWAITING_GUARANTOR") return "INVITED" as const;
  return "CONFIRMED" as const;
}

function completeness(state: FixtureState) {
  const applicantEvidence = state.evidence.applicant;
  const guarantorEvidence = state.evidence.guarantor;
  const applicantReady =
    state.vehicleModelId !== null &&
    Object.keys(state.applicantProfile).length > 0 &&
    applicantEvidence.consented &&
    applicantEvidence.identityVerified &&
    applicantEvidence.documentAccepted;
  const guarantorReady =
    state.guarantorDone &&
    Object.keys(state.guarantorProfile).length > 0 &&
    guarantorEvidence.consented &&
    guarantorEvidence.identityVerified &&
    guarantorEvidence.documentAccepted;
  const missing: string[] = [];
  if (!applicantReady) missing.push("APPLICANT_INCOMPLETE");
  if (!guarantorReady) missing.push("GUARANTOR_INCOMPLETE");
  return {
    ready: missing.length === 0 && state.status === "READY_TO_SUBMIT",
    missing,
    documentProgress: {
      applicant: {
        accepted: applicantEvidence.documentAccepted
          ? ["GHANA_CARD_FRONT"]
          : [],
        required: ["GHANA_CARD_FRONT"],
      },
      guarantor: {
        accepted: guarantorEvidence.documentAccepted
          ? ["GHANA_CARD_FRONT"]
          : [],
        required: ["GHANA_CARD_FRONT"],
      },
    },
  };
}

function draft(state: FixtureState) {
  return {
    id: applicationId,
    status: state.status,
    version: state.applicationVersion,
    vehicleModelId: state.vehicleModelId,
    applicantProfile: state.applicantProfile,
  };
}

function deriveInvitationToken(id: string): string {
  return createHmac("sha256", invitationSecret)
    .update(`somo:guarantor:invitation:v1\0${id}`)
    .digest("base64url");
}

async function fulfill(route: Route, status: number, body: unknown) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

class FixtureHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail);
  }
}
