import { describe, expect, it } from "vitest";
import {
  addMoney,
  compareMoney,
  fromMoneyDto,
  ghs,
  subtractMoney,
  toMoneyDto,
} from "./money.js";

describe("money", () => {
  it("creates GHS money only", () => {
    expect(ghs(0n)).toEqual({ currency: "GHS", minorUnits: 0n });
  });

  it("rejects negative minor units", () => {
    expect(() => ghs(-1n)).toThrowError("MONEY_VALUE_OUT_OF_RANGE");
  });

  it("adds minor units without floating point", () => {
    expect(addMoney(ghs(10_005n), ghs(995n))).toEqual(ghs(11_000n));
  });

  it("rejects arithmetic that exceeds signed 64-bit storage", () => {
    expect(() =>
      addMoney(ghs(9_223_372_036_854_775_807n), ghs(1n)),
    ).toThrowError("MONEY_VALUE_OUT_OF_RANGE");
  });

  it("rejects arithmetic across currencies", () => {
    const unsupportedCurrency = {
      currency: "USD",
      minorUnits: 1n,
    } as unknown as ReturnType<typeof ghs>;

    expect(() => addMoney(ghs(1n), unsupportedCurrency)).toThrowError(
      "MONEY_CURRENCY_NOT_SUPPORTED",
    );
  });

  it("subtracts exact minor units without allowing a negative balance", () => {
    expect(subtractMoney(ghs(11_000n), ghs(995n))).toEqual(ghs(10_005n));
    expect(() => subtractMoney(ghs(0n), ghs(1n))).toThrowError(
      "MONEY_VALUE_OUT_OF_RANGE",
    );
  });

  it("compares money by minor units", () => {
    expect(compareMoney(ghs(995n), ghs(10_005n))).toBe(-1);
    expect(compareMoney(ghs(10_005n), ghs(10_005n))).toBe(0);
    expect(compareMoney(ghs(10_005n), ghs(995n))).toBe(1);
  });

  it("serializes bigint as a decimal string", () => {
    expect(toMoneyDto(ghs(12_345n))).toEqual({
      currency: "GHS",
      minorUnits: "12345",
    });
  });

  it("converts decimal DTO minor units back to bigint", () => {
    expect(fromMoneyDto({ currency: "GHS", minorUnits: "12345" })).toEqual(
      ghs(12_345n),
    );
  });

  it("rejects non-canonical DTO values", () => {
    expect(() =>
      fromMoneyDto({ currency: "GHS", minorUnits: "01" }),
    ).toThrowError("MONEY_DTO_INVALID");
  });
});
