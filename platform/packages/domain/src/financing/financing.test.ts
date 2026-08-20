import { describe, expect, it } from "vitest";
import { FinancingEngine, type QuoteInput } from "./schedule.js";

const base: QuoteInput = {
  priceMinor: 100_000n,
  depositMinor: 20_000n,
  pricing: { method: "FLAT_MARKUP", markupBasisPoints: 1_000 },
  frequency: "MONTHLY",
  tenureMonths: 6,
  firstDueDate: "2026-01-31",
};

describe("financing engine", () => {
  it("rejects a deposit above the selling price", () => {
    expect(() =>
      FinancingEngine.quote({ ...base, depositMinor: 100_001n }),
    ).toThrow("DEPOSIT_EXCEEDS_PRICE");
  });

  it("uses calendar months and a final residual installment", () => {
    const quote = FinancingEngine.quote(base);

    expect(quote.installments.map((item) => item.dueDate)).toEqual([
      "2026-01-31",
      "2026-02-28",
      "2026-03-31",
      "2026-04-30",
      "2026-05-31",
      "2026-06-30",
    ]);
    expect(quote.principalMinor).toBe(80_000n);
    expect(quote.financeChargeMinor).toBe(8_000n);
    expect(quote.totalPayableMinor).toBe(88_000n);
    expect(quote.installments.map((item) => item.totalMinor)).toEqual([
      14_667n,
      14_667n,
      14_667n,
      14_667n,
      14_667n,
      14_665n,
    ]);
    expect(
      quote.installments.reduce((sum, item) => sum + item.totalMinor, 0n),
    ).toBe(quote.totalPayableMinor);
  });

  it("rounds flat charge and principal separately while finalizing residuals", () => {
    const quote = FinancingEngine.quote({
      ...base,
      priceMinor: 100_001n,
      depositMinor: 0n,
      tenureMonths: 8,
    });

    expect(quote.installments.slice(0, -1).every((item) => item.chargeMinor === 1_250n)).toBe(true);
    expect(quote.installments.at(-1)?.chargeMinor).toBe(1_250n);
    expect(quote.installments.reduce((sum, item) => sum + item.chargeMinor, 0n)).toBe(
      quote.financeChargeMinor,
    );
  });

  it("calculates reducing-balance interest with an exact final residual", () => {
    const quote = FinancingEngine.quote({
      ...base,
      pricing: { method: "REDUCING_BALANCE", annualRateBasisPoints: 1_200 },
      tenureMonths: 6,
      firstDueDate: "2026-02-01",
    });

    expect(quote.installments).toHaveLength(6);
    expect(quote.installments[0]?.chargeMinor).toBe(800n);
    expect(quote.installments.at(-1)?.principalMinor).toBeGreaterThan(0n);
    expect(
      quote.installments.reduce((sum, item) => sum + item.totalMinor, 0n),
    ).toBe(quote.totalPayableMinor);
    expect(
      quote.installments.reduce((sum, item) => sum + item.principalMinor, 0n),
    ).toBe(quote.principalMinor);
  });

  it("uses calendar weeks for weekly schedules", () => {
    const quote = FinancingEngine.quote({
      ...base,
      frequency: "WEEKLY",
      tenureMonths: 6,
      firstDueDate: "2026-01-31",
    });

    expect(quote.installments).toHaveLength(26);
    expect(quote.installments[0]?.dueDate).toBe("2026-01-31");
    expect(quote.installments[1]?.dueDate).toBe("2026-02-07");
    expect(quote.installments.at(-1)?.dueDate).toBe("2026-07-25");
  });

  it("rejects unsupported methods, frequencies, tenures, rates, and dates", () => {
    expect(() => FinancingEngine.quote({ ...base, frequency: "DAILY" as never })).toThrow(
      "FREQUENCY_NOT_SUPPORTED",
    );
    expect(() => FinancingEngine.quote({ ...base, tenureMonths: 7 as never })).toThrow(
      "TENURE_NOT_SUPPORTED",
    );
    expect(() =>
      FinancingEngine.quote({
        ...base,
        pricing: { method: "FLAT_MARKUP", markupBasisPoints: -1 },
      }),
    ).toThrow("RATE_INVALID");
    expect(() => FinancingEngine.quote({ ...base, firstDueDate: "2026-02-30" })).toThrow(
      "DATE_INVALID",
    );
  });
});
