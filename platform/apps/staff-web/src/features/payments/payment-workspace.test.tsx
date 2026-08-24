import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PaymentWorkspace } from "./payment-workspace.js";
import type { StaffPaymentsApi } from "../../lib/api.js";

describe("staff payment workspace", () => {
  it("shows payment inbox, reconciliation, settlement variance, and no-cash policy", async () => {
    const api = fakeApi();
    api.listPaymentInbox.mockResolvedValueOnce([
      {
        id: "inbox-1",
        providerEventId: "event-1",
        eventType: "PAYMENT_SUCCEEDED",
        processedAt: null,
      },
    ]);
    api.listReconciliationCases.mockResolvedValueOnce([
      { id: "case-1", reason: "UNMATCHED_CUSTOMER_REFERENCE", status: "OPEN" },
    ]);
    api.listSettlements.mockResolvedValueOnce([
      {
        id: "batch-1",
        settlementReference: "set-1",
        status: "VARIANCE",
        varianceMinorUnits: "100",
      },
    ]);
    render(<PaymentWorkspace api={api} actorId="staff-1" roles={["CFO"]} />);
    expect(screen.getByText("Loading payment reconciliation")).toBeVisible();
    expect(
      await screen.findByRole("heading", { name: "Payments reconciliation" }),
    ).toBeVisible();
    expect(
      screen.getByText("USSD and Mobile Money only. Cash is not accepted."),
    ).toBeVisible();
    expect(screen.getByText(/UNMATCHED_CUSTOMER_REFERENCE/)).toBeVisible();
    expect(screen.getByText(/set-1.*VARIANCE/)).toBeVisible();
  });

  it("only lets an independent checker decide a pending adjustment", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.listAdjustments.mockResolvedValueOnce([
      {
        id: "adjustment-1",
        makerStaffUserId: "maker-1",
        status: "PENDING",
        direction: "CREDIT",
        amountMinorUnits: "500",
        reason: "Correction",
      },
      {
        id: "adjustment-2",
        makerStaffUserId: "checker-1",
        status: "PENDING",
        direction: "DEBIT",
        amountMinorUnits: "200",
        reason: "Own request",
      },
    ]);
    render(<PaymentWorkspace api={api} actorId="checker-1" roles={["CFO"]} />);
    expect(
      await screen.findByRole("heading", { name: "Maker-checker adjustments" }),
    ).toBeVisible();
    expect(
      screen.getAllByRole("button", { name: "Approve adjustment" }),
    ).toHaveLength(1);
    await user.click(
      screen.getByRole("button", { name: "Approve adjustment" }),
    );
    expect(api.decideAdjustment).toHaveBeenCalledWith(
      "adjustment-1",
      expect.objectContaining({ decision: "APPROVE" }),
    );
    expect(await screen.findByText("Adjustment approved")).toBeVisible();
  });

  it("renders empty states and exposes maker request only to finance officers", async () => {
    const api = fakeApi();
    api.listPaymentInbox.mockResolvedValueOnce([]);
    api.listReconciliationCases.mockResolvedValueOnce([]);
    api.listSettlements.mockResolvedValueOnce([]);
    api.listAdjustments.mockResolvedValueOnce([]);
    render(
      <PaymentWorkspace
        api={api}
        actorId="maker-1"
        roles={["FINANCE_OFFICER"]}
      />,
    );
    expect(
      await screen.findByText("No payment events received."),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Request an adjustment" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Request credit adjustment" }),
    ).toBeVisible();
  });

  it("exposes authorized reconciliation resolution and settlement comparison controls", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.listReconciliationCases.mockResolvedValueOnce([
      { id: "case-1", reason: "SETTLEMENT_VARIANCE", status: "OPEN" },
    ]);
    render(<PaymentWorkspace api={api} actorId="cfo-1" roles={["CFO"]} />);
    await screen.findByText(/SETTLEMENT_VARIANCE/);
    await user.click(screen.getByRole("button", { name: "Resolve case" }));
    expect(api.resolveReconciliationCase).toHaveBeenCalledWith(
      "case-1",
      expect.objectContaining({ resolution: expect.any(Object) }),
    );
    await user.type(screen.getByLabelText("Settlement reference"), "set-1");
    await user.type(
      screen.getByLabelText("Provider total in minor units"),
      "1000",
    );
    await user.click(
      screen.getByRole("button", { name: "Compare settlement" }),
    );
    expect(api.compareSettlement).toHaveBeenCalledWith({
      settlementReference: "set-1",
      providerTotalMinorUnits: "1000",
    });
  });

  it("does not expose settlement comparison to the managing director", async () => {
    const api = fakeApi();
    render(<PaymentWorkspace api={api} actorId="md-1" roles={["MD"]} />);
    await screen.findByRole("heading", { name: "Payments reconciliation" });
    expect(
      screen.queryByRole("heading", { name: "Compare settlement" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Compare settlement" }),
    ).toBeNull();
  });
});

function fakeApi(): StaffPaymentsApi & {
  listPaymentInbox: ReturnType<typeof vi.fn>;
  listReconciliationCases: ReturnType<typeof vi.fn>;
  listSettlements: ReturnType<typeof vi.fn>;
  listAdjustments: ReturnType<typeof vi.fn>;
  decideAdjustment: ReturnType<typeof vi.fn>;
  resolveReconciliationCase: ReturnType<typeof vi.fn>;
  compareSettlement: ReturnType<typeof vi.fn>;
} {
  return {
    listPaymentInbox: vi.fn().mockResolvedValue([]),
    listReconciliationCases: vi.fn().mockResolvedValue([]),
    listSettlements: vi.fn().mockResolvedValue([]),
    listAdjustments: vi.fn().mockResolvedValue([]),
    requestAdjustment: vi
      .fn()
      .mockResolvedValue({ id: "requested-1", status: "PENDING" as const }),
    decideAdjustment: vi
      .fn()
      .mockResolvedValue({ id: "adjustment-1", status: "APPROVED" as const }),
    resolveReconciliationCase: vi.fn().mockResolvedValue(undefined),
    compareSettlement: vi
      .fn()
      .mockResolvedValue({ status: "MATCHED", varianceMinorUnits: "0" }),
  };
}
