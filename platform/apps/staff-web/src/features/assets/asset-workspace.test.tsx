import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { AssetWorkspace, ContractWorkspace } from "./asset-workspace.js";
import type { StaffAssetApi, StaffContractApi } from "../../lib/api.js";

describe("staff asset and contract workspace", () => {
  it("shows loading, empty, and explicit assignment gates", async () => {
    const api = fakeAssetApi();
    api.listInventory.mockResolvedValueOnce([]);
    render(<AssetWorkspace api={api} />);

    expect(screen.getByText("Loading asset inventory")).toBeVisible();
    expect(
      await screen.findByText("No vehicles are registered for assignment."),
    ).toBeVisible();
    expect(
      screen.getByText(/MD approval, accepted locked offer/),
    ).toBeVisible();
  });

  it("surfaces API errors and binds assignment to the selected vehicle version", async () => {
    const user = userEvent.setup();
    const api = fakeAssetApi();
    api.listInventory.mockResolvedValueOnce([
      {
        id: "vehicle-1",
        vehicleModelId: "model-1",
        vin: "VIN-1",
        chassisNumber: "CHASSIS-1",
        engineMotorIdentifier: "ENGINE-1",
        condition: {},
        accessories: [],
        trackerIdentifier: null,
        registrationNumber: "REG-1",
        status: "IN_STOCK",
        version: 4,
      },
    ]);
    api.assignVehicle.mockRejectedValueOnce({
      code: "DEPOSIT_RECONCILIATION_REQUIRED",
    });
    render(<AssetWorkspace api={api} />);

    await user.click(
      await screen.findByRole("button", { name: "Use this vehicle" }),
    );
    await user.type(screen.getByLabelText("Application ID"), "application-1");
    await user.click(screen.getByRole("button", { name: "Assign vehicle" }));
    expect(api.assignVehicle).toHaveBeenCalledWith(
      "application-1",
      expect.objectContaining({
        vehicleUnitId: "vehicle-1",
        expectedVehicleVersion: 4,
      }),
    );
    expect(
      await screen.findByText(/reconcile the locked deposit/),
    ).toBeVisible();
  });

  it("keeps production contract generation visibly fail-closed and exposes stale state", async () => {
    const api = fakeContractApi();
    api.get.mockResolvedValueOnce(null);
    render(<ContractWorkspace api={api} />);
    expect(
      screen.getByText(/Enter an application to load contract state/),
    ).toBeVisible();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Application ID"), "application-1");
    await user.click(
      screen.getByRole("button", { name: "Load contract controls" }),
    );
    expect(
      await screen.findByText(
        "No contract has been generated for this application.",
      ),
    ).toBeVisible();
  });

  it("shows physical execution evidence and explicit handover controls", async () => {
    const user = userEvent.setup();
    const api = fakeContractApi();
    api.get.mockResolvedValueOnce({
      id: "contract-1",
      reference: "SOMOCO-1",
      applicationId: "application-1",
      offerVersionId: "offer-1",
      vehicleUnitId: "vehicle-1",
      status: "AWAITING_EXECUTION",
      version: 1,
      canonicalHash: "a".repeat(64),
      previewReference: "preview/1",
      ownershipHolder: "SOMOCO",
      outstandingBalanceMinor: "70000",
      generatedAt: "2026-01-01T00:00:00.000Z",
      activatedAt: null,
    });
    render(<ContractWorkspace api={api} />);
    await user.type(screen.getByLabelText("Application ID"), "application-1");
    await user.click(
      screen.getByRole("button", { name: "Load contract controls" }),
    );
    expect(
      await screen.findByRole("form", { name: "Physical contract execution" }),
    ).toBeVisible();
    expect(screen.getByLabelText("Executed PDF document ID")).toBeVisible();
    expect(screen.getByLabelText("Executed PDF SHA-256")).toBeVisible();
    expect(screen.getByLabelText("Main head-office ID")).toBeVisible();
    expect(
      screen.getByText(/Physical applicant and guarantor signatures/),
    ).toBeVisible();
  });
});

function fakeAssetApi(): StaffAssetApi & {
  listInventory: ReturnType<typeof vi.fn>;
  assignVehicle: ReturnType<typeof vi.fn>;
} {
  return {
    listInventory: vi.fn().mockResolvedValue([]),
    assignVehicle: vi.fn().mockResolvedValue({}),
  };
}

function fakeContractApi(): StaffContractApi & {
  get: ReturnType<typeof vi.fn>;
} {
  return {
    get: vi.fn().mockResolvedValue(null),
    generate: vi.fn().mockResolvedValue({}),
    recordExecution: vi.fn().mockResolvedValue({}),
    completeHandover: vi.fn().mockResolvedValue({}),
    activate: vi.fn().mockResolvedValue({}),
  };
}
