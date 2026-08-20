import {
  act,
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
  afterEach(() => {
    vi.useRealTimers();
    window.history.replaceState({}, "", "/");
  });

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

  it("records consent, verifies NIA, and uploads accepted applicant evidence without persistence", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(
      <CustomerRouter
        api={api}
        initialSession={session()}
        initialPhoneE164="+233241000001"
      />,
    );
    await screen.findByRole("heading", { name: "Continue your application" });

    await user.click(
      screen.getByRole("checkbox", {
        name: "I agree to identity verification",
      }),
    );
    await user.type(screen.getByLabelText("Ghana Card number"), "GHA-123456789-1");
    await user.click(
      screen.getByRole("button", { name: "Verify identity" }),
    );

    expect(api.recordConsent).toHaveBeenCalledWith({
      purpose: "NIA_IDENTITY_VERIFICATION",
      documentVersion: "nia-consent-v1",
      phoneE164: "+233241000001",
    });
    expect(api.verifyGhanaCard).toHaveBeenCalledWith({
      consentId: "30000000-0000-4000-8000-000000000001",
      ghanaCardNumber: "GHA-123456789-1",
      idempotencyKey: expect.any(String),
    });
    expect(await screen.findByText("Identity verified")).toBeVisible();

    const image = new File([new Uint8Array([1, 2, 3, 4])], "card.jpg", {
      type: "image/jpeg",
    });
    await user.upload(
      screen.getByLabelText("GHANA_CARD_FRONT evidence"),
      image,
    );

    expect(api.requestDocumentUpload).toHaveBeenCalledWith({
      documentType: "GHANA_CARD_FRONT",
      mimeType: "image/jpeg",
      sizeBytes: 4,
    });
    expect(api.uploadDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        documentId: "40000000-0000-4000-8000-000000000001",
      }),
      expect.any(Blob),
      expect.any(Function),
    );
    expect(api.completeDocumentUpload).toHaveBeenCalledWith(
      "40000000-0000-4000-8000-000000000001",
    );
    expect(await screen.findByText("GHANA_CARD_FRONT accepted")).toBeVisible();
    expect(JSON.stringify(localStorage)).not.toMatch(
      /GHA-123456789-1|card\.jpg|sessionToken/i,
    );
  });

  it("authenticates an invited guarantor independently without loading applicant data", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const invitationToken = "g".repeat(43);
    window.history.replaceState({}, "", `/#invitation=${invitationToken}`);
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
    expect(api.resolveGuarantorInvitation).toHaveBeenCalledWith(
      invitationToken,
    );
    expect(screen.queryByLabelText("Vehicle model")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Residential area")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", {
        name: "I agree to identity verification",
      }),
    );
    await user.type(screen.getByLabelText("Ghana Card number"), "GHA-987654321-0");
    await user.click(screen.getByRole("button", { name: "Verify identity" }));
    expect(api.recordConsent).toHaveBeenCalledWith(
      expect.objectContaining({ phoneE164: "+233241000002" }),
    );
    expect(await screen.findByText("Identity verified")).toBeVisible();
    await user.upload(
      screen.getByLabelText("GHANA_CARD_FRONT evidence"),
      new File([new Uint8Array([5, 6, 7])], "guarantor-card.jpg", {
        type: "image/jpeg",
      }),
    );
    expect(
      await screen.findByText("GHANA_CARD_FRONT accepted"),
    ).toBeVisible();
    await user.type(screen.getByLabelText("Occupation"), "Mechanic");
    await user.type(
      screen.getByLabelText("Relationship to applicant"),
      "Sibling",
    );
    await user.click(
      screen.getByRole("button", { name: "Save guarantor details" }),
    );

    expect(api.saveGuarantor).toHaveBeenCalledWith(invitationToken, {
      expectedVersion: 2,
      mutationId: expect.any(String),
      profile: { occupation: "Mechanic", relationshipToApplicant: "Sibling" },
    });
    expect(
      await screen.findByText("Your details were sent securely."),
    ).toBeVisible();
    expect(JSON.stringify(localStorage)).not.toMatch(
      /GHA-987654321-0|guarantor-card\.jpg|sessionToken/i,
    );
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

  it("shows expired invitations, reinvites, and uses the returned application version", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.loadOnboarding.mockResolvedValueOnce({
      ...onboardingState(),
      draft: { ...onboardingState().draft!, version: 7 },
      guarantorStatus: "EXPIRED",
      guarantorInvitation: {
        status: "EXPIRED",
        relationshipVersion: 1,
        expiresAt: "2026-08-14T12:00:00.000Z",
      },
    });
    api.inviteGuarantor.mockResolvedValueOnce({
      invitationId: "50000000-0000-4000-8000-000000000002",
      applicationVersion: 8,
      relationshipVersion: 2,
      expiresAt: "2026-08-20T12:30:00.000Z",
    });
    render(
      <CustomerRouter
        api={api}
        initialSession={session()}
        initialPhoneE164="+233241000001"
      />,
    );
    expect(await screen.findByText("Invitation expired")).toBeVisible();
    await user.type(
      screen.getByLabelText("Guarantor mobile number"),
      "+233241000002",
    );
    await user.click(
      screen.getByRole("button", { name: "Send new invitation" }),
    );
    expect(api.inviteGuarantor).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      expect.objectContaining({ expectedVersion: 7 }),
    );

    await user.selectOptions(
      screen.getByLabelText("Vehicle model"),
      "20000000-0000-4000-8000-000000000001",
    );
    await user.type(screen.getByLabelText("Occupation"), "Courier");
    await user.type(screen.getByLabelText("Residential area"), "Dansoman");
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(api.saveApplicant).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-000000000001",
      expect.objectContaining({ expectedVersion: 8 }),
    );
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
    expect(summary).toHaveFocus();
    await user.click(
      within(summary).getByRole("link", {
        name: "Tell us your current occupation.",
      }),
    );
    expect(screen.getByLabelText("Occupation")).toHaveFocus();
  });

  it("refreshes and reconciles a version conflict without treating it as offline", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const refreshed = onboardingState();
    refreshed.models = [
      ...refreshed.models,
      {
        id: "20000000-0000-4000-8000-000000000002",
        manufacturer: "Remote Motors",
        modelName: "Reconciled Car",
        modelYear: 2027,
      },
    ];
    refreshed.draft = {
      ...refreshed.draft!,
      version: 6,
      vehicleModelId: "20000000-0000-4000-8000-000000000002",
      applicantProfile: {
        occupation: "Remote occupation",
        residentialArea: "Remote area",
      },
    };
    api.loadOnboarding
      .mockResolvedValueOnce(onboardingState())
      .mockResolvedValueOnce(refreshed);
    api.saveApplicant
      .mockRejectedValueOnce({
        code: "VERSION_CONFLICT",
        detail: "This draft changed on another device.",
      })
      .mockResolvedValueOnce({
        ...onboardingState().draft!,
        version: 7,
      });
    render(
      <CustomerRouter
        api={api}
        initialSession={session()}
        initialPhoneE164="+233241000001"
      />,
    );
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
        "Draft changed elsewhere. We refreshed it; review and save again.",
      ),
    ).toBeVisible();
    expect(localStorage.getItem("somo-safe-mutations-v1")).toBeNull();
    expect(screen.getByLabelText("Vehicle model")).toHaveValue(
      "20000000-0000-4000-8000-000000000002",
    );
    expect(screen.getByLabelText("Occupation")).toHaveValue(
      "Remote occupation",
    );
    expect(screen.getByLabelText("Residential area")).toHaveValue(
      "Remote area",
    );
    await user.click(screen.getByRole("button", { name: "Save and continue" }));
    expect(api.saveApplicant.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        expectedVersion: 6,
        vehicleModelId: "20000000-0000-4000-8000-000000000002",
        profile: {
          occupation: "Remote occupation",
          residentialArea: "Remote area",
        },
      }),
    );
  });

  it("refreshes and explains an invitation version conflict", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    const refreshed = onboardingState();
    refreshed.guarantorStatus = "EXPIRED";
    refreshed.guarantorInvitation = {
      status: "EXPIRED",
      relationshipVersion: 1,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    api.loadOnboarding
      .mockResolvedValueOnce(onboardingState())
      .mockResolvedValueOnce(refreshed);
    api.inviteGuarantor.mockRejectedValueOnce({
      code: "VERSION_CONFLICT",
      detail: "This draft changed on another device.",
    });
    render(
      <CustomerRouter
        api={api}
        initialSession={session()}
        initialPhoneE164="+233241000001"
      />,
    );
    await screen.findByRole("heading", { name: "Continue your application" });
    await user.type(
      screen.getByLabelText("Guarantor mobile number"),
      "+233241000002",
    );
    await user.click(screen.getByRole("button", { name: "Send invitation" }));

    expect(api.loadOnboarding).toHaveBeenCalledTimes(2);
    expect(
      await screen.findByText(
        "Draft changed elsewhere. We refreshed it; review and save again.",
      ),
    ).toBeVisible();
    expect(screen.getByText("Invitation expired")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Send new invitation" }),
    ).toBeVisible();
  });

  it("reports a server save failure without placing it in the offline queue", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.saveApplicant.mockRejectedValueOnce({
      code: "SERVICE_UNAVAILABLE",
      detail: "The service is temporarily unavailable.",
    });
    render(<CustomerRouter api={api} initialSession={session()} />);

    await screen.findByRole("heading", { name: "Continue your application" });
    await user.selectOptions(
      screen.getByLabelText("Vehicle model"),
      "20000000-0000-4000-8000-000000000001",
    );
    await user.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(
      await screen.findByText("Draft could not be saved. Try again."),
    ).toBeVisible();
    expect(localStorage.getItem("somo-safe-mutations-v1")).toBeNull();
  });

  it("warns before idle expiry and requires fresh authentication when the session expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T10:00:00.000Z"));
    const api = fakeApi();
    render(
      <CustomerRouter
        api={api}
        initialSession={{
          sessionToken: "s".repeat(43),
          expiresAt: "2026-08-20T10:06:00.000Z",
        }}
      />,
    );
    await act(async () => Promise.resolve());
    expect(
      screen.getByRole("heading", { name: "Continue your application" }),
    ).toBeVisible();
    expect(
      screen.queryByText("Your secure session expires soon. Save your draft now."),
    ).not.toBeInTheDocument();

    await act(async () => vi.advanceTimersByTime(60_001));
    expect(
      screen.getByText("Your secure session expires soon. Save your draft now."),
    ).toBeVisible();

    await act(async () => vi.advanceTimersByTime(5 * 60_000));
    expect(
      screen.getByText("Your secure session expired. Sign in again."),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Sign in securely" }),
    ).toBeVisible();
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
    guarantorInvitation: {
      status: "NOT_INVITED",
      relationshipVersion: null,
      expiresAt: null,
    },
  };
}

function fakeApi() {
  const state = onboardingState();
  return {
    requestOtp: vi.fn<CustomerApi["requestOtp"]>(async () => undefined),
    verifyOtp: vi.fn<CustomerApi["verifyOtp"]>(async () => session()),
    loadOnboarding: vi.fn<CustomerApi["loadOnboarding"]>(async () => state),
    createDraft: vi.fn<CustomerApi["createDraft"]>(async () => state.draft!),
    recordConsent: vi.fn(async () => ({
      consentId: "30000000-0000-4000-8000-000000000001",
    })),
    verifyGhanaCard: vi.fn(async () => ({ status: "VERIFIED" as const })),
    requestDocumentUpload: vi.fn(async () => ({
      documentId: "40000000-0000-4000-8000-000000000001",
      uploadUrl: "https://objects.test/upload",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      requiredHeaders: { "content-type": "image/jpeg" },
    })),
    uploadDocument: vi.fn(async (_ticket, _file, onProgress) => {
      onProgress(4, 4);
    }),
    completeDocumentUpload: vi.fn(async (documentId) => ({
      documentId,
      status: "ACCEPTED" as const,
      sha256: "a".repeat(64),
    })),
    saveApplicant: vi.fn<CustomerApi["saveApplicant"]>(
      async () => state.draft!,
    ),
    inviteGuarantor: vi.fn<CustomerApi["inviteGuarantor"]>(async () => ({
      invitationId: "50000000-0000-4000-8000-000000000001",
      applicationVersion: 3,
      relationshipVersion: 1,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    })),
    resolveGuarantorInvitation: vi.fn<
      CustomerApi["resolveGuarantorInvitation"]
    >(async () => ({
      status: "INVITED",
      relationshipVersion: 2,
      applicationVersion: 4,
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
