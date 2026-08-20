import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { OfferPanel, type OfferApi } from "./offer-panel.js";

describe("customer financing offer", () => {
  it("shows a locked offer and requires explicit disclosure consent", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    render(<OfferPanel api={api} applicationId="application-1" />);

    expect(screen.getByText("Loading financing offer")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Your financing offer" })).toBeVisible();
    expect(screen.getByText("GHS 100,000.00")).toBeVisible();
    expect(screen.getByText("6 monthly installments")).toBeVisible();
    expect(screen.getByText("GHS 88,000.00 total cost")).toBeVisible();
    expect(screen.getByRole("button", { name: "Accept financing offer" })).toBeDisabled();

    await user.click(screen.getByRole("checkbox", { name: /I have read and agree/i }));
    expect(screen.getByRole("button", { name: "Accept financing offer" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Accept financing offer" }));
    expect(api.accept).toHaveBeenCalledWith("offer-1", expect.objectContaining({ consent: true }));
    expect(await screen.findByText("Offer accepted")).toBeVisible();
  });

  it("explains an expired offer and never exposes hashes as disclosures", async () => {
    const api = fakeApi();
    api.get.mockResolvedValueOnce({
      ...offer(),
      status: "EXPIRED",
    });
    render(<OfferPanel api={api} applicationId="application-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("This offer has expired.");
    expect(screen.queryByText(/canonical|sha256|fixture/i)).not.toBeInTheDocument();
  });

  it("renders a fail-closed disabled state", async () => {
    const api = fakeApi();
    api.get.mockResolvedValueOnce(null);
    render(<OfferPanel api={api} applicationId="application-1" />);
    expect(await screen.findByText("No licensed financing offer is available.")).toBeVisible();
  });
});

function offer() {
  return {
    id: "offer-1",
    status: "PENDING" as const,
    expiresAt: "2026-08-21T12:00:00.000Z",
    priceMinor: "10000000",
    depositMinor: "2000000",
    frequency: "MONTHLY" as const,
    tenureMonths: 6 as const,
    totalPayableMinor: "8800000",
    financeChargeMinor: "800000",
    installments: [
      { sequence: 1, dueDate: "2026-01-31", totalMinor: "1466667" },
    ],
    disclosureVersion: "disclosure-v1",
  };
}

function fakeApi(): OfferApi & { get: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(offer()),
    accept: vi.fn().mockResolvedValue({ ...offer(), status: "ACCEPTED" }),
  };
}
