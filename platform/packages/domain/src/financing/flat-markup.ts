import { roundHalfUp, sum } from "./math.js";
import type { Installment } from "./types.js";

export interface FlatMarkupQuote {
  financeChargeMinor: bigint;
  totalPayableMinor: bigint;
  installments: readonly Installment[];
}

/**
 * Flat markup is charged once on the financed principal. The charge and the
 * contractual total are rounded half-up to GHS minor units. Every non-final
 * installment receives the rounded contractual total; the final installment
 * absorbs the exact residual.
 */
export function calculateFlatMarkup(
  principalMinor: bigint,
  markupBasisPoints: number,
  dueDates: readonly string[],
): FlatMarkupQuote {
  if (dueDates.length === 0) throw new Error("TENURE_NOT_SUPPORTED");
  const financeChargeMinor = roundHalfUp(
    principalMinor * BigInt(markupBasisPoints),
    10_000n,
  );
  const totalPayableMinor = principalMinor + financeChargeMinor;
  const count = BigInt(dueDates.length);
  const regularTotal = roundHalfUp(totalPayableMinor, count);
  const regularCharge = roundHalfUp(financeChargeMinor, count);
  const regularPrincipal = regularTotal - regularCharge;
  const installments: Installment[] = [];
  let principalUsed = 0n;
  let chargeUsed = 0n;
  for (let index = 0; index < dueDates.length; index += 1) {
    const final = index === dueDates.length - 1;
    const principal = final ? principalMinor - principalUsed : regularPrincipal;
    const charge = final ? financeChargeMinor - chargeUsed : regularCharge;
    const total = principal + charge;
    installments.push({
      sequence: index + 1,
      dueDate: dueDates[index]!,
      principalMinor: principal,
      chargeMinor: charge,
      totalMinor: total,
    });
    principalUsed += principal;
    chargeUsed += charge;
  }
  if (sum(installments.map((item) => item.totalMinor)) !== totalPayableMinor) {
    throw new Error("SCHEDULE_RESIDUAL_INVALID");
  }
  return { financeChargeMinor, totalPayableMinor, installments };
}

