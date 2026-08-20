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

  it("keeps an accepted offer accepted after its expiry timestamp", async () => {
    const api = fakeApi();
    api.get.mockResolvedValueOnce({
      ...offer(),
      status: "ACCEPTED",
      expiresAt: "2026-08-19T12:00:00.000Z",
    });
    render(<OfferPanel api={api} applicationId="application-1" />);
    expect(await screen.findByText("Offer accepted")).toBeVisible();
    expect(screen.queryByText("This offer has expired.")).not.toBeInTheDocument();
  });

  it("shows the installment count from the returned schedule for weekly plans", async () => {
    const api = fakeApi();
    api.get.mockResolvedValueOnce({
      ...offer(),
      frequency: "WEEKLY",
      installments: [
        { sequence: 1, dueDate: "2026-09-01", totalMinor: "2933334" },
        { sequence: 2, dueDate: "2026-09-08", totalMinor: "2933333" },
        { sequence: 3, dueDate: "2026-09-15", totalMinor: "2933333" },
      ],
    });
    render(<OfferPanel api={api} applicationId="application-1" />);
    expect(await screen.findByText("3 weekly installments")).toBeVisible();
  });
});

function offer() {
  return {
    id: "offer-1",
    version: 1,
    status: "PENDING" as const,
    expiresAt: "2026-08-21T12:00:00.000Z",
    priceMinor: "10000000",
    depositMinor: "2000000",
    frequency: "MONTHLY" as const,
    tenureMonths: 6 as const,
    totalPayableMinor: "8800000",
    financeChargeMinor: "800000",
    installments: Array.from({ length: 6 }, (_, index) => ({
      sequence: index + 1,
      dueDate: `2026-0${index + 1}-31`,
      totalMinor: "1466667",
    })),
    disclosureVersion: "disclosure-v1",
    disclosureContent: { version: "disclosure-v1", body: "Synthetic test disclosure" },
    disclosedHash: "a".repeat(64),
    fees: {},
  };
}

function fakeApi(): OfferApi & { get: ReturnType<typeof vi.fn>; accept: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(offer()),
    accept: vi.fn().mockResolvedValue({ ...offer(), status: "ACCEPTED" }),
  };
}
