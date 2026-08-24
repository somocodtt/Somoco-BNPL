import { describe, expect, it } from "vitest";
import { computeArrears, type ArrearsInstallment } from "./arrears.js";

function row(
  installmentNumber: number,
  dueDate: string,
  amountMinor: bigint,
  postedMinor: bigint,
): ArrearsInstallment {
  return { installmentNumber, dueDate, amountMinor, postedMinor };
}

describe("computeArrears", () => {
  it("excludes future installments at the exact calendar boundary", () => {
    expect(
      computeArrears({
        asOfDate: "2026-08-21",
        installments: [
          row(1, "2026-08-20", 100n, 100n),
          row(2, "2026-08-21", 200n, 0n),
          row(3, "2026-08-22", 300n, 0n),
        ],
      }),
    ).toMatchObject({
      asOfDate: "2026-08-21",
      overdueMinor: 200n,
      totalUnpaid: 1,
      consecutiveMissed: 1,
      escalationSignals: [],
    });
  });

  it("reports an on-time account with no signals", () => {
    expect(
      computeArrears({
        asOfDate: "2026-08-31",
        installments: [
          row(1, "2026-08-01", 100n, 100n),
          row(2, "2026-08-08", 100n, 100n),
        ],
      }).overdueMinor,
    ).toBe(0n);
  });

  it("counts three consecutive missed installments independently", () => {
    const result = computeArrears({
      asOfDate: "2026-08-31",
      installments: [
        row(1, "2026-08-01", 100n, 0n),
        row(2, "2026-08-08", 100n, 0n),
        row(3, "2026-08-15", 100n, 0n),
        row(4, "2026-08-22", 100n, 100n),
      ],
    });
    expect(result.consecutiveMissed).toBe(3);
    expect(result.totalUnpaid).toBe(3);
    expect(result.escalationSignals).toEqual([
      "THREE_CONSECUTIVE_MISSED",
      "THREE_TOTAL_UNPAID",
    ]);
  });

  it("reports three total nonconsecutive unpaid without a consecutive signal", () => {
    const result = computeArrears({
      asOfDate: "2026-08-31",
      installments: [
        row(1, "2026-08-01", 100n, 0n),
        row(2, "2026-08-08", 100n, 100n),
        row(3, "2026-08-15", 100n, 0n),
        row(4, "2026-08-22", 100n, 100n),
        row(5, "2026-08-29", 100n, 0n),
      ],
    });
    expect(result.consecutiveMissed).toBe(1);
    expect(result.totalUnpaid).toBe(3);
    expect(result.escalationSignals).toEqual(["THREE_TOTAL_UNPAID"]);
  });

  it("uses net posted ledger allocation for partial payments and reversals", () => {
    expect(
      computeArrears({
        asOfDate: "2026-08-31",
        installments: [
          row(1, "2026-08-01", 500n, 250n),
          row(2, "2026-08-08", 500n, 0n),
        ],
      }).overdueMinor,
    ).toBe(750n);
    expect(
      computeArrears({
        asOfDate: "2026-08-31",
        installments: [row(1, "2026-08-01", 500n, 0n)],
      }).totalUnpaid,
    ).toBe(1);
  });

  it("supports monthly dates without timezone conversion", () => {
    const result = computeArrears({
      asOfDate: "2026-03-31",
      installments: [
        row(1, "2026-01-31", 100n, 0n),
        row(2, "2026-02-28", 100n, 100n),
        row(3, "2026-03-31", 101n, 0n),
      ],
    });
    expect(result.overdueMinor).toBe(201n);
    expect(result.totalUnpaid).toBe(2);
  });

  it("rejects malformed dates and impossible ledger values", () => {
    expect(() =>
      computeArrears({ asOfDate: "2026-02-30", installments: [] }),
    ).toThrow("ARREARS_DATE_INVALID");
    expect(() =>
      computeArrears({
        asOfDate: "2026-08-31",
        installments: [row(1, "2026-08-01", 10n, 11n)],
      }),
    ).toThrow("ARREARS_POSTED_INVALID");
  });
});
