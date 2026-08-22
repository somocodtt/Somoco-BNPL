import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StaffRouter } from "./app/router.js";
import type { StaffCollectionsApi } from "./features/collections/collections-workspace.js";

function collectionsApi(): StaffCollectionsApi {
  return {
    listArrears: vi.fn().mockResolvedValue([]),
    listCases: vi.fn().mockResolvedValue([]),
    decideRecoveryCase: vi.fn(),
    getRecoveryLocation: vi.fn(),
  };
}

describe("staff collections route", () => {
  it("routes a collections officer to the collections workspace", async () => {
    const api = collectionsApi();
    render(
      <StaffRouter
        api={{
          getQueue: vi.fn(),
          getApplication: vi.fn(),
          decide: vi.fn(),
        }}
        initialSession={{
          staffUserId: "recovery-officer",
          roles: ["RECOVERY_OFFICER"],
          csrfToken: "csrf",
        }}
        collectionsApi={api}
      />,
    );

    expect(await screen.findByText("Arrears and recovery")).toBeVisible();
    expect(screen.getByText("No arrears signals.")).toBeVisible();
    expect(screen.getByText("No recovery cases.")).toBeVisible();
    expect(api.listArrears).toHaveBeenCalledTimes(1);
  });
});
