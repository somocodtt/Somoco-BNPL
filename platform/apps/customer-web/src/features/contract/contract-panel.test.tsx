import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
      contractId: "contract-1",
      status: "ACTIVE",
      previewAvailable: true,
      executed: true,
      assignedVehicleAvailable: true,
      registrationNumber: "GR-1234-24",
      registrationValidTo: "2027-12-31",
      insuranceValidTo: "2027-12-31",
      handoverAcknowledged: true,
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

  it("keeps physical acknowledgement applicant-driven and checklist-bound", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.getContract.mockResolvedValueOnce({
      contractId: "contract-1",
      status: "EXECUTED",
      previewAvailable: true,
      executed: true,
      assignedVehicleAvailable: false,
      registrationNumber: null,
      registrationValidTo: null,
      insuranceValidTo: null,
      handoverAcknowledged: false,
      schedule: [],
    });
    render(<ContractPanel api={api} applicationId="application-1" />);
    await user.click(
      await screen.findByRole("button", { name: "Acknowledge handover" }),
    );
    expect(api.acknowledgeHandover).toHaveBeenCalledWith(
      "contract-1",
      expect.objectContaining({
        checklistVersion: "handover-v1",
        checklist: expect.objectContaining({ items: expect.any(Array) }),
      }),
    );
    expect(
      await screen.findByText("Your handover acknowledgement is recorded."),
    ).toBeVisible();
  });
});

function fakeApi(): ContractApi & { getContract: ReturnType<typeof vi.fn> } {
  return {
    acknowledgeHandover: vi.fn().mockResolvedValue({
      id: "ack-1",
      acknowledgedAt: "2026-01-01T00:00:00.000Z",
    }),
    getContract: vi.fn().mockResolvedValue({
      contractId: "contract-1",
      status: "AWAITING_EXECUTION" as const,
      previewAvailable: true,
      executed: false,
      assignedVehicleAvailable: false,
      registrationNumber: null,
      registrationValidTo: null,
      insuranceValidTo: null,
      handoverAcknowledged: false,
      schedule: [],
    }),
  };
}
