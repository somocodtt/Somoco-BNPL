import {
  expect,
  test,
  type BrowserContext,
  type Route,
} from "@playwright/test";

const applicationId = "10000000-0000-4000-8000-000000000001";
const vehicleModelId = "20000000-0000-4000-8000-000000000001";
const invitationToken = "g".repeat(43);

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
    await signIn(applicant, "+233241000001", fixture);
    await applicant.getByLabel("Vehicle model").selectOption(vehicleModelId);
    await applicant.getByLabel("Occupation").fill("Courier");
    await applicant.getByLabel("Residential area").fill("Dansoman");
    await applicant.getByRole("button", { name: "Save and continue" }).click();
    await expect(applicant.getByText("Draft saved")).toBeVisible();
    await applicant.getByLabel("Guarantor mobile number").fill("+233241000002");
    await applicant.getByRole("button", { name: "Send invitation" }).click();
    await expect(
      applicant.getByText("Invitation sent. Waiting for the guarantor."),
    ).toBeVisible();

    await guarantor.goto(`/?invitation=${invitationToken}`);
    await signIn(guarantor, "+233241000002", fixture);
    await expect(
      guarantor.getByRole("heading", {
        name: "Complete your guarantor details",
      }),
    ).toBeVisible();
    await expect(guarantor.getByLabel("Vehicle model")).toHaveCount(0);
    await expect(guarantor.getByLabel("Residential area")).toHaveCount(0);
    await guarantor.getByLabel("Occupation").fill("Mechanic");
    await guarantor.getByLabel("Relationship to applicant").fill("Sibling");
    await guarantor
      .getByRole("button", { name: "Save guarantor details" })
      .click();
    await expect(
      guarantor.getByText("Your details were sent securely."),
    ).toBeVisible();

    await applicant.reload();
    await signIn(applicant, "+233241000001", fixture);
    await applicant.getByRole("button", { name: "Submit application" }).click();
    await expect(
      applicant.getByText("Your application is in verification review."),
    ).toBeVisible();
    await expect(
      applicant
        .getByRole("list", { name: "Application status" })
        .getByText("Verification review"),
    ).toHaveAttribute("aria-current", "step");
  } finally {
    await applicantContext.close();
    await guarantorContext.close();
  }
});

async function signIn(
  page: import("@playwright/test").Page,
  phone: string,
  state: FixtureState,
) {
  const priorRequests = state.otpRequests;
  await page.getByLabel("Mobile number").fill(phone);
  const observedRequest = page.waitForRequest((request) =>
    request.url().includes("/otp/requests"),
  );
  await page.getByRole("button", { name: "Send code" }).click();
  const request = await observedRequest;
  expect(
    state.otpRequests,
    `observed browser request ${request.method()} ${request.url()} but fixture did not intercept it`,
  ).toBe(priorRequests + 1);
  await expect(page.getByLabel("Verification code")).toBeVisible();
  await page.getByLabel("Verification code").fill("619204");
  await page.getByRole("button", { name: "Continue" }).click();
}

interface FixtureState {
  status: string;
  version: number;
  vehicleModelId: string | null;
  applicantProfile: Record<string, unknown>;
  guarantorDone: boolean;
  otpRequests: number;
}

function onboardingFixture(): FixtureState {
  return {
    status: "DRAFT",
    version: 1,
    vehicleModelId: null,
    applicantProfile: {},
    guarantorDone: false,
    otpRequests: 0,
  };
}

async function installApi(context: BrowserContext, state: FixtureState) {
  await context.route("**/v1/customer/**", async (route) =>
    respond(route, state),
  );
}

async function respond(route: Route, state: FixtureState) {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  let body: unknown = {};
  if (path.endsWith("/otp/requests")) {
    state.otpRequests += 1;
  } else if (path.endsWith("/otp/verifications")) {
    body = {
      sessionToken: "s".repeat(43),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  } else if (path.endsWith("/vehicle-models")) {
    body = [
      {
        id: vehicleModelId,
        manufacturer: "Synthetic Motors",
        modelName: "Pilot Bike",
        modelYear: 2026,
      },
    ];
  } else if (path.endsWith("/applications/resume")) {
    body = {
      draft: draft(state),
      guarantorStatus: state.guarantorDone
        ? "CONFIRMED"
        : state.version >= 3
          ? "INVITED"
          : "NOT_INVITED",
    };
  } else if (path.endsWith("/completeness")) {
    body = {
      ready: state.guarantorDone,
      missing: state.guarantorDone ? [] : ["GUARANTOR_INCOMPLETE"],
      documentProgress: {
        applicant: {
          accepted: ["GHANA_CARD_FRONT"],
          required: ["GHANA_CARD_FRONT"],
        },
        guarantor: {
          accepted: state.guarantorDone ? ["GHANA_CARD_FRONT"] : [],
          required: ["GHANA_CARD_FRONT"],
        },
      },
    };
  } else if (path.endsWith("/applicant") && method === "PATCH") {
    const input = request.postDataJSON() as {
      vehicleModelId: string;
      profile: Record<string, unknown>;
    };
    state.vehicleModelId = input.vehicleModelId;
    state.applicantProfile = input.profile;
    state.version = 2;
    body = draft(state);
  } else if (path.endsWith("/guarantor-invitations")) {
    state.status = "AWAITING_GUARANTOR";
    state.version = 3;
    body = {
      token: invitationToken,
      applicationVersion: 3,
      expiresAt: new Date(Date.now() + 1_800_000).toISOString(),
    };
  } else if (path.endsWith("/guarantor") && method === "PATCH") {
    state.guarantorDone = true;
    state.status = "READY_TO_SUBMIT";
    state.version = 4;
    body = { applicationVersion: 4 };
  } else if (path.endsWith("/submissions")) {
    state.status = "VERIFICATION_REVIEW";
    state.version = 5;
    body = draft(state);
  }
  await route.fulfill({
    status: path.endsWith("/guarantor-invitations") ? 201 : 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function draft(state: FixtureState) {
  return {
    id: applicationId,
    status: state.status,
    version: state.version,
    vehicleModelId: state.vehicleModelId,
    applicantProfile: state.applicantProfile,
  };
}
