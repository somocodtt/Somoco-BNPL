import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerRouter } from "./app/router.js";
import type {
  ApplicantMutation,
  CustomerApi,
  OnboardingState,
} from "./lib/api.js";
import { shouldCacheRequest } from "./service-worker.js";

describe("customer onboarding PWA", () => {
  afterEach(() => window.history.replaceState({}, "", "/"));

  it("logs in by phone and resumes the model, applicant, document and status steps", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<CustomerRouter api={api} />);

    await user.type(screen.getByLabelText("Mobile number"), "+233241000001");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    expect(api.requestOtp).toHaveBeenCalledWith("+233241000001");
    await user.type(screen.getByLabelText("Verification code"), "619204");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", { name: "Continue your application" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Vehicle model")).toHaveValue("");
    expect(screen.getByLabelText("Occupation")).toBeVisible();
    expect(screen.getByText("0 of 1 documents accepted")).toBeVisible();
    expect(screen.getByText("Guarantor not invited")).toBeVisible();
    expect(
      within(
        screen.getByRole("list", { name: "Application status" }),
      ).getByText("Draft"),
    ).toBeVisible();
    expect(screen.queryByText(/staff|admin/i)).not.toBeInTheDocument();
  });

  it("invites one guarantor and exposes the updated status", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<CustomerRouter api={api} initialSession={session()} />);

    await screen.findByRole("heading", { name: "Continue your application" });
    await user.type(
      screen.getByLabelText("Guarantor mobile number"),
      "+233241000002",
    );
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(api.inviteGuarantor).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      expect.objectContaining({
        expectedVersion: 2,
        mutationId: expect.any(String),
        guarantorPhoneE164: "+233241000002",
      }),
    );
    expect(
      await screen.findByText("Invitation sent. Waiting for the guarantor."),
    ).toBeVisible();
  });

  it("authenticates an invited guarantor independently without loading applicant data", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const invitationToken = "g".repeat(43);
    window.history.replaceState({}, "", `/?invitation=${invitationToken}`);
    render(<CustomerRouter api={api} />);

    await user.type(screen.getByLabelText("Mobile number"), "+233241000002");
    await user.click(screen.getByRole("button", { name: "Send code" }));
    await user.type(screen.getByLabelText("Verification code"), "619204");
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByRole("heading", {
        name: "Complete your guarantor details",
      }),
    ).toBeVisible();
    expect(api.loadOnboarding).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Vehicle model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Residential area")).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Occupation"), "Mechanic");
    await user.type(
      screen.getByLabelText("Relationship to applicant"),
      "Sibling",
    );
    await user.click(
      screen.getByRole("button", { name: "Save guarantor details" }),
    );

    expect(api.saveGuarantor).toHaveBeenCalledWith(invitationToken, {
      expectedVersion: 1,
      mutationId: expect.any(String),
      profile: { occupation: "Mechanic", relationshipToApplicant: "Sibling" },
    });
    expect(
      await screen.findByText("Your details were sent securely."),
    ).toBeVisible();
  });

  it("submits only a complete ready draft and shows verification review", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.loadOnboarding.mockResolvedValueOnce({
      ...onboardingState(),
      draft: {
        ...onboardingState().draft!,
        status: "READY_TO_SUBMIT",
        version: 4,
      },
      completeness: {
        ...onboardingState().completeness,
        ready: true,
        missing: [],
      },
      guarantorStatus: "CONFIRMED",
    });
    render(<CustomerRouter api={api} initialSession={session()} />);

    await screen.findByRole("heading", { name: "Continue your application" });
    await user.click(
      screen.getByRole("button", { name: "Submit application" }),
    );

    expect(api.submit).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      {
        expectedVersion: 4,
        mutationId: expect.any(String),
      },
    );
    expect(
      await screen.findByText("Your application is in verification review."),
    ).toBeVisible();
  });

  it("focuses the named field from an accessible server error summary", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.saveApplicant.mockRejectedValueOnce({
      code: "VALIDATION_ERROR",
      fieldErrors: { occupation: "Tell us your current occupation." },
    });
    render(<CustomerRouter api={api} initialSession={session()} />);

    await screen.findByRole("heading", { name: "Continue your application" });
    await user.selectOptions(
      screen.getByLabelText("Vehicle model"),
      "20000000-0000-4000-8000-000000000001",
    );
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    const summary = await screen.findByRole("alert");
    expect(
      within(summary).getByRole("heading", { name: "There is a problem" }),
    ).toBeVisible();
    await user.click(
      within(summary).getByRole("link", {
        name: "Tell us your current occupation.",
      }),
    );
    expect(screen.getByLabelText("Occupation")).toHaveFocus();
  });

  it("retries an offline save with one mutation id and no stored secrets", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.saveApplicant
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce({
        ...onboardingState().draft!,
        status: "DRAFT",
        version: 3,
      });
    render(<CustomerRouter api={api} initialSession={session()} />);

    await screen.findByRole("heading", { name: "Continue your application" });
    await user.selectOptions(
      screen.getByLabelText("Vehicle model"),
      "20000000-0000-4000-8000-000000000001",
    );
    await user.type(screen.getByLabelText("Occupation"), "Courier");
    await user.type(screen.getByLabelText("Residential area"), "Dansoman");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(
      await screen.findByText(
        "Saved on this device; will retry when you are online",
      ),
    ).toBeVisible();

    const persisted = localStorage.getItem("somo-safe-mutations-v1") ?? "";
    expect(persisted).not.toMatch(
      /619204|GHA-|ghana.?card|otp|document|sessionToken/i,
    );
    const first = api.saveApplicant.mock.calls[0]?.[1] as ApplicantMutation;
    fireEvent(window, new Event("online"));
    await waitFor(() => expect(api.saveApplicant).toHaveBeenCalledTimes(2));
    const retried = api.saveApplicant.mock.calls[1]?.[1] as ApplicantMutation;
    expect(retried.mutationId).toBe(first.mutationId);

    expect(await screen.findByText("Offline changes saved")).toBeVisible();
    expect(localStorage.getItem("somo-safe-mutations-v1")).toBeNull();
  });

  it("caches only versioned static assets and excludes every sensitive response class", () => {
    expect(
      shouldCacheRequest(
        new Request("https://customer.test/assets/app.a81f02cd.js"),
      ),
    ).toBe(true);
    expect(
      shouldCacheRequest(
        new Request("https://customer.test/assets/app.DXGLXIOd.css"),
      ),
    ).toBe(true);
    for (const path of [
      "/v1/customer/applications/1",
      "/v1/customer/documents/1/download",
      "/identity/ghana-card",
      "/receipts/1.pdf",
      "/contracts/1.pdf",
      "/assets/app.js",
    ]) {
      expect(
        shouldCacheRequest(new Request(`https://customer.test${path}`)),
      ).toBe(false);
    }
    expect(
      shouldCacheRequest(
        new Request("https://customer.test/assets/app.a81f02cd.js", {
          method: "POST",
        }),
      ),
    ).toBe(false);
  });
});

function onboardingState(): OnboardingState {
  return {
    draft: {
      id: "10000000-0000-4000-8000-000000000001",
      status: "DRAFT",
      version: 2,
      vehicleModelId: null,
      applicantProfile: {},
    },
    models: [
      {
        id: "20000000-0000-4000-8000-000000000001",
        manufacturer: "Synthetic Motors",
        modelName: "Pilot Bike",
        modelYear: 2026,
      },
    ],
    completeness: {
      ready: false,
      missing: ["APPLICANT_DETAILS_INCOMPLETE"],
      documentProgress: {
        applicant: { accepted: [], required: ["GHANA_CARD_FRONT"] },
        guarantor: { accepted: [], required: ["GHANA_CARD_FRONT"] },
      },
    },
    guarantorStatus: "NOT_INVITED",
  };
}

function fakeApi() {
  const state = onboardingState();
  return {
    requestOtp: vi.fn<CustomerApi["requestOtp"]>(async () => undefined),
    verifyOtp: vi.fn<CustomerApi["verifyOtp"]>(async () => session()),
    loadOnboarding: vi.fn<CustomerApi["loadOnboarding"]>(async () => state),
    createDraft: vi.fn<CustomerApi["createDraft"]>(async () => state.draft!),
    saveApplicant: vi.fn<CustomerApi["saveApplicant"]>(
      async () => state.draft!,
    ),
    inviteGuarantor: vi.fn<CustomerApi["inviteGuarantor"]>(async () => ({
      applicationVersion: 3,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })),
    saveGuarantor: vi.fn<CustomerApi["saveGuarantor"]>(async () => ({
      applicationVersion: 4,
    })),
    submit: vi.fn<CustomerApi["submit"]>(async () => ({
      ...state.draft!,
      status: "VERIFICATION_REVIEW",
      version: 5,
    })),
  } satisfies CustomerApi;
}

function session() {
  return {
    sessionToken: "s".repeat(43),
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  };
}
