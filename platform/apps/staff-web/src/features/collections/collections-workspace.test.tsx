import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CollectionsWorkspace,
  type StaffCollectionsApi,
} from "./collections-workspace.js";

function fakeApi(): StaffCollectionsApi & {
  listArrears: ReturnType<typeof vi.fn>;
  listCases: ReturnType<typeof vi.fn>;
  decideRecoveryCase: ReturnType<typeof vi.fn>;
  getRecoveryLocation: ReturnType<typeof vi.fn>;
} {
  return {
    listArrears: vi.fn().mockResolvedValue([]),
    listCases: vi.fn().mockResolvedValue([]),
    decideRecoveryCase: vi.fn().mockResolvedValue({ status: "APPROVED" }),
    getRecoveryLocation: vi.fn().mockResolvedValue({
      locationOnly: true,
      latitude: 5.6,
      longitude: -0.2,
    }),
  };
}

describe("staff collections workspace", () => {
  it("shows explicit loading and empty states", async () => {
    const api = fakeApi();
    render(<CollectionsWorkspace api={api} actorId="officer-1" />);
    expect(screen.getByText("Loading collections queue")).toBeVisible();
    expect(await screen.findByText("No arrears signals.")).toBeVisible();
    expect(screen.getByText("No recovery cases.")).toBeVisible();
  });

  it("separates arrears signals and requires human case decisions", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.listArrears.mockResolvedValueOnce([
      {
        id: "signal-1",
        contractId: "contract-1",
        signal: "THREE_CONSECUTIVE_MISSED",
        unpaidCount: 3,
        asOfDate: "2026-08-21",
      },
      {
        id: "signal-2",
        contractId: "contract-2",
        signal: "THREE_TOTAL_UNPAID",
        unpaidCount: 4,
        asOfDate: "2026-08-21",
      },
    ]);
    api.listCases.mockResolvedValueOnce([
      {
        id: "case-1",
        contractId: "contract-1",
        status: "OPEN",
        purpose: "Human recovery review",
        makerStaffUserId: "maker-1",
      },
    ]);
    render(<CollectionsWorkspace api={api} actorId="checker-1" />);
    expect(
      await screen.findByText(/THREE_CONSECUTIVE_MISSED[\s\S]*3 unpaid/),
    ).toBeVisible();
    expect(screen.getByText(/THREE_TOTAL_UNPAID[\s\S]*4 unpaid/)).toBeVisible();
    expect(
      screen.getByText("No automatic vehicle action is taken."),
    ).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Approve recovery case" }),
    );
    expect(api.decideRecoveryCase).toHaveBeenCalledWith(
      "case-1",
      expect.objectContaining({
        decision: "APPROVED",
        reason: expect.any(String),
      }),
    );
    expect(await screen.findByText("Recovery case approved")).toBeVisible();
  });
});
