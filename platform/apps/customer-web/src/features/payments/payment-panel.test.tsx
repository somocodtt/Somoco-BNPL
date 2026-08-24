import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PaymentPanel } from "./payment-panel.js";
import type { CustomerPaymentsApi } from "../../lib/api.js";

function api(
  overrides: Partial<CustomerPaymentsApi> &
    Partial<{
      getPaymentAccounts(): Promise<readonly Record<string, unknown>[]>;
      getReceipt(receiptId: string): Promise<Record<string, unknown>>;
    }> = {},
): CustomerPaymentsApi & {
  getPaymentAccounts: ReturnType<typeof vi.fn>;
  getReceipt: ReturnType<typeof vi.fn>;
} {
  return {
    getPaymentInstructions: vi.fn(async () => ({
      channel: "USSD_MOBILE_MONEY" as const,
      ussdInstructions: "Dial the approved Somoco USSD code.",
      cashAccepted: false as const,
    })),
    getPayments: vi.fn(async () => []),
    getReceipts: vi.fn(async () => []),
    getPaymentAccounts: vi.fn(async () => []),
    getReceipt: vi.fn(async (receiptId: string) => ({ receiptId })),
    ...overrides,
  } as CustomerPaymentsApi & {
    getPaymentAccounts: ReturnType<typeof vi.fn>;
    getReceipt: ReturnType<typeof vi.fn>;
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
          getPaymentAccounts: vi.fn(async () => [
            {
              contractId: "c1",
              contractReference: "C-1",
              outstandingBalanceMinorUnits: "87500",
              nextDueDate: "2026-08-28",
            },
          ]),
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

  it("loads contract accounts for balance and due dates even when payment history is empty", async () => {
    const customerApi = api({
      getPaymentAccounts: vi.fn(async () => [
        {
          contractId: "contract-1",
          contractReference: "CONTRACT-1",
          outstandingBalanceMinorUnits: "100000",
          nextDueDate: "2026-09-01",
        },
      ]),
    });
    render(<PaymentPanel api={customerApi} />);
    await waitFor(() =>
      expect(customerApi.getPaymentAccounts).toHaveBeenCalledOnce(),
    );
    expect(
      await screen.findByText("Outstanding balance: GHS 1000.00"),
    ).toBeInTheDocument();
    expect(screen.getByText("Next due date: 2026-09-01")).toBeInTheDocument();
  });
});
