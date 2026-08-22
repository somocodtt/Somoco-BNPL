import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerRouter } from "./app/router.js";
import type { CustomerApi, CustomerSession } from "./lib/api.js";

const session: CustomerSession = {
  sessionToken: "customer-session",
  expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
};
const routeContractId = "11111111-1111-4111-8111-111111111111";

function api(): CustomerApi & {
  getAccountStatus: ReturnType<typeof vi.fn>;
  listReminders: ReturnType<typeof vi.fn>;
} {
  return {
    requestOtp: vi.fn(),
    verifyOtp: vi.fn(),
    loadOnboarding: vi
      .fn()
      .mockRejectedValue(new Error("not an onboarding route")),
    createDraft: vi.fn(),
    recordConsent: vi.fn(),
    verifyGhanaCard: vi.fn(),
    requestDocumentUpload: vi.fn(),
    uploadDocument: vi.fn(),
    completeDocumentUpload: vi.fn(),
    saveApplicant: vi.fn(),
    inviteGuarantor: vi.fn(),
    resolveGuarantorInvitation: vi.fn(),
    saveGuarantor: vi.fn(),
    submit: vi.fn(),
    getAccountStatus: vi.fn().mockResolvedValue([
      {
        contractId: routeContractId,
        contractStatus: "ACTIVE",
        outstandingBalanceMinorUnits: "10000",
        nextDueDate: "2026-09-01",
        overdueMinorUnits: "0",
        consecutiveMissedPayments: 0,
        totalUnpaidPayments: 0,
        signals: [],
        cashAccepted: false,
      },
    ]),
    listReminders: vi.fn().mockResolvedValue([]),
  };
}

afterEach(() => {
  window.history.replaceState({}, "", "/");
});

describe("customer collections route", () => {
  it("renders the authenticated customer status panel for a contract route", async () => {
    const customerApi = api();
    window.history.replaceState(
      {},
      "",
      `/account/contracts/${routeContractId}/status`,
    );

    render(<CustomerRouter api={customerApi} initialSession={session} />);

    expect(await screen.findByText("Contract status: ACTIVE")).toBeVisible();
    expect(customerApi.getAccountStatus).toHaveBeenCalledTimes(1);
    expect(customerApi.listReminders).toHaveBeenCalledTimes(1);
    expect(customerApi.loadOnboarding).not.toHaveBeenCalled();
  });
});
