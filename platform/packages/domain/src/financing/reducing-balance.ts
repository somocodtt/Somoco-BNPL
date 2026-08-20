import { powBigInt, roundHalfUp, sum } from "./math.js";
import type { Installment } from "./types.js";

export interface ReducingBalanceQuote {
  financeChargeMinor: bigint;
  totalPayableMinor: bigint;
  installments: readonly Installment[];
}

/**
 * Reducing-balance interest uses a nominal annual rate converted to 12 or 52
 * equal contractual periods. Interest is rounded half-up per period against
 * the opening balance; the final principal payment absorbs residual balance.
 */
export function calculateReducingBalance(
  principalMinor: bigint,
  annualRateBasisPoints: number,
  frequency: "WEEKLY" | "MONTHLY",
  dueDates: readonly string[],
): ReducingBalanceQuote {
  if (dueDates.length === 0) throw new Error("TENURE_NOT_SUPPORTED");
  const periodsPerYear = frequency === "WEEKLY" ? 52 : 12;
  const periods = dueDates.length;
  const rateNumerator = BigInt(annualRateBasisPoints);
  const rateDenominator = BigInt(10_000 * periodsPerYear);
  const count = BigInt(periods);
  let regularTotal: bigint;
  if (rateNumerator === 0n || principalMinor === 0n) {
    regularTotal = roundHalfUp(principalMinor, count);
  } else {
    const growthNumerator = rateDenominator + rateNumerator;
    const growthNumeratorPower = powBigInt(growthNumerator, periods);
    const growthDenominatorPower = powBigInt(rateDenominator, periods);
    const paymentNumerator =
      principalMinor * rateNumerator * growthNumeratorPower;
    const paymentDenominator =
      rateDenominator * (growthNumeratorPower - growthDenominatorPower);
    regularTotal = roundHalfUp(paymentNumerator, paymentDenominator);
  }

  const installments: Installment[] = [];
  let balance = principalMinor;
  for (let index = 0; index < dueDates.length; index += 1) {
    const charge = roundHalfUp(balance * rateNumerator, rateDenominator);
    const expectedPrincipal = regularTotal - charge;
    const final = index === dueDates.length - 1;
    const principal =
      final || expectedPrincipal >= balance
        ? balance
        : expectedPrincipal > 0n
          ? expectedPrincipal
          : 0n;
    const total = principal + charge;
    installments.push({
      sequence: index + 1,
      dueDate: dueDates[index]!,
      principalMinor: principal,
      chargeMinor: charge,
      totalMinor: total,
    });
    balance -= principal;
  }
  if (balance !== 0n) throw new Error("SCHEDULE_RESIDUAL_INVALID");
  const financeChargeMinor = sum(installments.map((item) => item.chargeMinor));
  const totalPayableMinor = principalMinor + financeChargeMinor;
  if (sum(installments.map((item) => item.totalMinor)) !== totalPayableMinor) {
    throw new Error("SCHEDULE_RESIDUAL_INVALID");
  }
  return { financeChargeMinor, totalPayableMinor, installments };
}

