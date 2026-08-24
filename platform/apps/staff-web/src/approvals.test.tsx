import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { StaffRouter } from "./app/router.js";
import { ProblemError, type StaffApi } from "./lib/api.js";

describe("staff approval workspace", () => {
  it("shows one actionable queue and an accessible review detail", async () => {
    const api = fakeApi();
    render(
      <StaffRouter
        api={api}
        initialSession={{
          staffUserId: "staff-1",
          roles: ["VERIFICATION_OFFICER"],
        }}
      />,
    );

    expect(screen.getByText("Loading actionable queue")).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { name: "Verification queue" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "Open application" }),
    ).toHaveLength(1);

    await userEvent.click(
      screen.getByRole("button", { name: "Open application" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Application review" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Immutable applicant snapshot"),
    ).toBeInTheDocument();
    expect(screen.getByText(/NIA: VERIFIED/)).toBeInTheDocument();
    expect(screen.getByText("Document scan: CLEAN")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Approve application" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Request information" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Reject application" }),
    ).toBeEnabled();
  });

  it("submits the current stage and version and exposes stale conflicts", async () => {
    const api = fakeApi();
    render(
      <StaffRouter
        api={api}
        initialSession={{
          staffUserId: "staff-1",
          roles: ["VERIFICATION_OFFICER"],
        }}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Open application" }),
    );
    await userEvent.type(
      screen.getByLabelText("Decision note"),
      "Evidence verified",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Approve application" }),
    );
    expect(api.decide).toHaveBeenCalledWith("application-1", {
      action: "APPROVE",
      stage: "VERIFICATION",
      expectedVersion: 4,
      note: "Evidence verified",
      idempotencyKey: expect.any(String),
    });
    expect(await screen.findByText("Decision saved")).toBeInTheDocument();
  });

  it("renders a real stale conflict and refresh affordance", async () => {
    const api = fakeApi();
    api.decide.mockRejectedValue(
      new ProblemError("STALE_VERSION", 409, "The application changed."),
    );
    render(
      <StaffRouter
        api={api}
        initialSession={{
          staffUserId: "staff-1",
          roles: ["VERIFICATION_OFFICER"],
        }}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Open application" }),
    );
    await userEvent.type(
      screen.getByLabelText("Decision note"),
      "Evidence verified",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Approve application" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This application is stale. Refresh the review before deciding.",
    );
    expect(
      screen.getByRole("button", { name: "Refresh stale application" }),
    ).toBeInTheDocument();
  });

  it("exposes explicit request-information and reject outcomes", async () => {
    const api = fakeApi();
    render(
      <StaffRouter
        api={api}
        initialSession={{
          staffUserId: "staff-1",
          roles: ["VERIFICATION_OFFICER"],
        }}
      />,
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Open application" }),
    );
    await userEvent.type(
      screen.getByLabelText("Decision note"),
      "More evidence needed",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Request information" }),
    );
    expect(api.decide).toHaveBeenCalledWith(
      "application-1",
      expect.objectContaining({ action: "REQUEST_INFORMATION" }),
    );
    expect(
      await screen.findByText("Information requested"),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Reject application" }),
    );
    expect(api.decide).toHaveBeenLastCalledWith(
      "application-1",
      expect.objectContaining({ action: "REJECT" }),
    );
    expect(await screen.findByText("Application rejected")).toBeInTheDocument();
  });
});

function fakeApi(): StaffApi & { decide: ReturnType<typeof vi.fn> } {
  const decide = vi.fn().mockResolvedValue({
    status: "BSM_INITIAL_REVIEW",
    version: 5,
  });
  return {
    getQueue: vi.fn().mockResolvedValue([
      {
        id: "application-1",
        status: "VERIFICATION_REVIEW",
        version: 4,
        submittedAt: "2026-08-20T10:00:00.000Z",
        snapshot: { applicantName: "Ama Mensah" },
      },
    ]),
    getApplication: vi.fn().mockResolvedValue({
      id: "application-1",
      status: "VERIFICATION_REVIEW",
      version: 4,
      snapshot: {
        applicantName: "Ama Mensah",
        nia: { status: "VERIFIED", reference: "nia-1" },
        documents: { scanState: "CLEAN" },
        statements: [{ period: "July 2026", state: "PRESENT" }],
      },
      decisions: [],
      underwriting: [],
    }),
    decide,
  };
}
