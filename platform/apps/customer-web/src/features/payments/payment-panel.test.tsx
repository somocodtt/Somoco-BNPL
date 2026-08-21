import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaymentPanel } from "./payment-panel.js";
import type { CustomerPaymentsApi } from "../../lib/api.js";

function api(
  overrides: Partial<CustomerPaymentsApi> = {},
): CustomerPaymentsApi {
  return {
    getPaymentInstructions: vi.fn(async () => ({
      channel: "USSD_MOBILE_MONEY" as const,
      ussdInstructions: "Dial the approved Somoco USSD code.",
      cashAccepted: false as const,
    })),
    getPayments: vi.fn(async () => []),
    getReceipts: vi.fn(async () => []),
    ...overrides,
  };
}

describe("customer payment panel", () => {
  it("shows explicit loading and empty states without a cash control", async () => {
    render(<PaymentPanel api={api()} />);
    expect(screen.getByText("Loading payment account")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("No posted payments yet.")).toBeInTheDocument(),
    );
    expect(screen.getByText("No receipts yet.")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /cash/i }),
    ).not.toBeInTheDocument();
  });

  it("shows instructions, balance, posted payment, and receipt", async () => {
    render(
      <PaymentPanel
        api={api({
          getPayments: vi.fn(async () => [
            {
              id: "p1",
              providerTransactionId: "txn",
              amountMinorUnits: "12500",
              currency: "GHS" as const,
              status: "POSTED",
              occurredAt: "2026-08-21T12:00:00.000Z",
              contractReference: "C-1",
              outstandingBalanceMinorUnits: "87500",
              nextDueDate: "2026-08-28",
            },
          ]),
          getReceipts: vi.fn(async () => [
            {
              id: "r1",
              receiptNumber: "SOMO-1",
              paymentTransactionId: "p1",
              amountMinorUnits: "12500",
              currency: "GHS" as const,
              issuedAt: "2026-08-21T12:00:00.000Z",
              securePath: "/account/receipts/p1",
            },
          ]),
        })}
      />,
    );
    await waitFor(() =>
      expect(
        screen.getByText("Dial the approved Somoco USSD code."),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByText("Outstanding balance: GHS 875.00"),
    ).toBeInTheDocument();
    expect(screen.getByText("Next due date: 2026-08-28")).toBeInTheDocument();
    expect(screen.getByText("SOMO-1")).toBeInTheDocument();
  });

  it("shows a safe error state", async () => {
    render(
      <PaymentPanel
        api={api({
          getPayments: vi.fn(async () => {
            throw new Error("provider");
          }),
        })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("could not load"),
    );
  });
});
