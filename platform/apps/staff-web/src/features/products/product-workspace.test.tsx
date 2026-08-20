import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProductWorkspace, type ProductApi } from "./product-workspace.js";

describe("staff product workspace", () => {
  it("shows maker-checker rules and a fail-closed fixture gate", async () => {
    const api = fakeApi();
    render(<ProductWorkspace api={api} actorId="checker-1" />);

    expect(screen.getByText("Loading product controls")).toBeVisible();
    expect(await screen.findByRole("heading", { name: "Financing products" })).toBeVisible();
    expect(screen.getByText("Finance and Compliance fixture gate: closed")).toBeVisible();
    expect(screen.getByText("Requested by maker-1")).toBeVisible();
    expect(screen.getByRole("button", { name: "Publish rule version" })).toBeDisabled();
    expect(screen.getByText("No approved fixtures are registered.")).toBeVisible();
  });

  it("keeps the requester from deciding an exception and surfaces stale conflicts", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    api.listRules.mockResolvedValueOnce([]);
    api.listExceptions.mockResolvedValueOnce([
      {
        id: "exception-1",
        status: "PENDING",
        requestedBy: "requester-1",
        requiredApproverRole: "CFO",
        proposedValue: "10",
        policyValue: "5",
        reason: "Documented hardship",
        version: 1,
      },
    ]);
    api.decideException.mockRejectedValueOnce({ code: "STALE_VERSION" });
    render(<ProductWorkspace api={api} actorId="cfo-1" />);
    expect(await screen.findByRole("heading", { name: "Controlled exceptions" })).toBeVisible();
    expect(screen.getByText("Documented hardship")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Approve exception" }));
    expect(api.decideException).toHaveBeenCalledWith("exception-1", expect.objectContaining({ expectedVersion: 1 }));
    expect(await screen.findByText("Refresh the exception before deciding.")).toBeVisible();
  });

  it("only enables pending exception actions and renders structured values", async () => {
    const api = fakeApi();
    api.listRules.mockResolvedValueOnce([]);
    api.listExceptions.mockResolvedValueOnce([
      {
        id: "exception-approved",
        status: "APPROVED",
        requestedBy: "maker-1",
        requiredApproverRole: "CFO",
        proposedValue: { minimumDepositMinor: "10000" },
        policyValue: { minimumDepositMinor: "30000" },
        reason: "Already approved",
        version: 2,
      },
    ]);
    render(<ProductWorkspace api={api} actorId="cfo-1" roles={["CFO"]} />);
    expect(await screen.findByText(/minimumDepositMinor.*10000/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Approve exception" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject exception" })).toBeNull();
  });

  it("keeps publishing restricted to product administrators", async () => {
    const api = fakeApi();
    api.listRules.mockResolvedValueOnce([
      {
        id: "rule-open",
        versionNumber: 1,
        status: "DRAFT",
        requestedBy: "maker-1",
        effectiveFrom: null,
        gate: "OPEN",
      },
    ]);
    render(<ProductWorkspace api={api} actorId="checker-1" roles={["CFO"]} />);
    expect(await screen.findByRole("button", { name: "Publish rule version" })).toBeDisabled();
  });
});

function fakeApi(): ProductApi & {
  listRules: ReturnType<typeof vi.fn>;
  listExceptions: ReturnType<typeof vi.fn>;
  decideException: ReturnType<typeof vi.fn>;
} {
  return {
    listRules: vi.fn().mockResolvedValue([
      {
        id: "rule-1",
        versionNumber: 1,
        status: "DRAFT" as const,
        requestedBy: "maker-1",
        effectiveFrom: null,
        gate: "CLOSED" as const,
      },
    ]),
    listExceptions: vi.fn().mockResolvedValue([]),
    publish: vi.fn().mockResolvedValue(undefined),
    decideException: vi.fn().mockResolvedValue(undefined),
  };
}
