import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ReportsWorkspace } from "./reports-workspace.js";
import type { StaffMigrationApi, StaffReportsApi } from "../../lib/api.js";

function reportsApi(): StaffReportsApi {
  return {
    getReport: vi.fn().mockResolvedValue({
      dataClassification: "REDACTED",
      rows: [],
      migrationTotals: { batches: 0, records: 0 },
    }),
    exportReport: vi.fn().mockResolvedValue({ id: "export-1" }),
    getExport: vi.fn(),
  };
}

function migrationApi(): StaffMigrationApi {
  return {
    listBatches: vi
      .fn()
      .mockResolvedValue([
        { id: "batch-1", sourceBatchId: "legacy-1", status: "VALIDATED" },
      ]),
    importBatch: vi.fn().mockResolvedValue({}),
    validate: vi.fn().mockResolvedValue({}),
    verify: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({}),
    activateMigration: vi.fn().mockResolvedValue({}),
  };
}

describe("reports workspace", () => {
  it("shows server redaction, empty states, attribution, and auditor read-only controls", async () => {
    const api = reportsApi();
    const migration = migrationApi();
    render(
      <ReportsWorkspace
        api={api}
        migrationApi={migration}
        roles={["COMPLIANCE_AUDITOR"]}
      />,
    );

    expect(screen.getByText("Loading operational reporting")).toBeVisible();
    expect(
      await screen.findByText("Server-enforced classification: REDACTED"),
    ).toBeVisible();
    expect(
      screen.getByText("No records match the selected report filters."),
    ).toBeVisible();
    expect(screen.getByText(/legacy-1/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Verify sample" }),
    ).not.toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Export operations CSV" }),
    );
    expect(api.exportReport).toHaveBeenCalledWith({
      report: "operations",
      format: "CSV",
    });
    expect(
      await screen.findByText("Export export-1 attributed to the requester."),
    ).toBeVisible();
  });

  it("shows finance approval only for finance roles and requires evidence", async () => {
    const api = reportsApi();
    const migration = migrationApi();
    migration.listBatches = vi.fn().mockResolvedValue([
      {
        id: "batch-2",
        sourceBatchId: "legacy-2",
        status: "VALIDATED",
        expectedRecords: 1,
        expectedTotalMinorUnits: "100",
        reconciledTotalMinorUnits: "100",
        sampleRequired: 1,
        samplePassed: 1,
        verifiedBy: "verifier-1",
      },
    ]);
    render(
      <ReportsWorkspace api={api} migrationApi={migration} roles={["CFO"]} />,
    );

    expect(
      await screen.findByLabelText("Financial evidence hash for batch-2"),
    ).toBeVisible();
    const approve = screen.getByRole("button", {
      name: "Approve reconciled batch",
    });
    expect(approve).toBeDisabled();
    await userEvent.type(
      screen.getByLabelText("Financial evidence hash for batch-2"),
      "a".repeat(64),
    );
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    expect(migration.approve).toHaveBeenCalledWith("batch-2", "a".repeat(64));
  });
});
