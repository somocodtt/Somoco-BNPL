import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  AccountStatusPanel,
  type CustomerCollectionsApi,
} from "./account-status-panel.js";

function api(): CustomerCollectionsApi & {
  getAccountStatus: ReturnType<typeof vi.fn>;
  listReminders: ReturnType<typeof vi.fn>;
} {
  return {
    getAccountStatus: vi.fn().mockResolvedValue([
      {
        contractId: "contract-1",
        contractStatus: "ACTIVE",
        outstandingBalanceMinorUnits: "87500",
        nextDueDate: "2026-08-28",
        overdueMinorUnits: "12500",
        consecutiveMissedPayments: 3,
        totalUnpaidPayments: 3,
        signals: ["THREE_CONSECUTIVE_MISSED", "THREE_TOTAL_UNPAID"],
        cashAccepted: false,
      },
    ]),
    listReminders: vi.fn().mockResolvedValue([
      {
        id: "reminder-1",
        status: "QUEUED",
        message: "Payment reminder",
        createdAt: "2026-08-21T10:00:00.000Z",
      },
    ]),
  };
}

describe("customer account status panel", () => {
  it("shows loading then arrears status, reminders, and no-cash policy", async () => {
    const customerApi = api();
    render(<AccountStatusPanel api={customerApi} />);
    expect(screen.getByText("Loading account status")).toBeVisible();
    expect(await screen.findByText("Contract status: ACTIVE")).toBeVisible();
    expect(screen.getByText("Outstanding balance: GHS 875.00")).toBeVisible();
    expect(screen.getByText("Overdue amount: GHS 125.00")).toBeVisible();
    expect(screen.getByText("3 consecutive missed payments")).toBeVisible();
    expect(screen.getByText("3 total unpaid payments")).toBeVisible();
    expect(screen.getByText("Cash is not accepted.")).toBeVisible();
    expect(screen.getByText(/Payment reminder[\s\S]*QUEUED/)).toBeVisible();
  });

  it("shows a safe error state", async () => {
    const customerApi = api();
    customerApi.getAccountStatus.mockRejectedValueOnce(new Error("offline"));
    render(<AccountStatusPanel api={customerApi} />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not load",
    );
  });

  it("shows an explicit empty account state", async () => {
    const customerApi = api();
    customerApi.getAccountStatus.mockResolvedValueOnce([]);
    customerApi.listReminders.mockResolvedValueOnce([]);
    render(<AccountStatusPanel api={customerApi} />);
    expect(
      await screen.findByText("No active customer accounts were found."),
    ).toBeVisible();
  });
});
