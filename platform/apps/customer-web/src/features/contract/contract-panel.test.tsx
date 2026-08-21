import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ContractPanel, type ContractApi } from "./contract-panel.js";

describe("customer contract panel", () => {
  it("shows loading and keeps unsigned preview separate from handover vehicle details", async () => {
    const api = fakeApi();
    render(<ContractPanel api={api} applicationId="application-1" />);

    expect(
      screen.getByText("Loading contract and handover state"),
    ).toBeVisible();
    expect(
      await screen.findByText(
        "Unsigned contract preview is available for review.",
      ),
    ).toBeVisible();
    expect(
      screen.getByText(/Assigned vehicle details remain locked/),
    ).toBeVisible();
    expect(
      screen.queryByText(/VIN|tracker|sha256|canonical/i),
    ).not.toBeInTheDocument();
  });

  it("renders executed handover summary and schedule without exposing internal hashes", async () => {
    const api = fakeApi();
    api.getContract.mockResolvedValueOnce({
      status: "ACTIVE",
      previewAvailable: true,
      executed: true,
      assignedVehicleAvailable: true,
      registrationNumber: "GR-1234-24",
      registrationValidTo: "2027-12-31",
      insuranceValidTo: "2027-12-31",
      schedule: [{ sequence: 1, dueDate: "2026-09-01", totalMinor: "77000" }],
    });
    render(<ContractPanel api={api} applicationId="application-1" />);

    expect(await screen.findByText("Contract status: ACTIVE")).toBeVisible();
    expect(screen.getByText("GR-1234-24")).toBeVisible();
    expect(screen.getByText("GHS 770.00")).toBeVisible();
    expect(
      screen.queryByText(/sha256|canonical|tracker/i),
    ).not.toBeInTheDocument();
  });

  it("fails closed when the customer contract endpoint is unavailable", async () => {
    const api = fakeApi();
    api.getContract.mockRejectedValueOnce(new Error("offline"));
    render(<ContractPanel api={api} applicationId="application-1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "We could not load your contract state.",
    );
  });
});

function fakeApi(): ContractApi & { getContract: ReturnType<typeof vi.fn> } {
  return {
    getContract: vi.fn().mockResolvedValue({
      status: "AWAITING_EXECUTION" as const,
      previewAvailable: true,
      executed: false,
      assignedVehicleAvailable: false,
      registrationNumber: null,
      registrationValidTo: null,
      insuranceValidTo: null,
      schedule: [],
    }),
  };
}
