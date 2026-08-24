export const SUPPORTED_TENURES = [6, 8, 12, 24, 36, 48] as const;
export type SupportedTenure = (typeof SUPPORTED_TENURES)[number];
export type RepaymentFrequency = "WEEKLY" | "MONTHLY";

export type PricingMethod =
  | { method: "FLAT_MARKUP"; markupBasisPoints: number }
  | { method: "REDUCING_BALANCE"; annualRateBasisPoints: number };

export interface QuoteInput {
  priceMinor: bigint;
  depositMinor: bigint;
  pricing: PricingMethod;
  frequency: RepaymentFrequency;
  tenureMonths: SupportedTenure;
  firstDueDate: string;
}

export interface Installment {
  sequence: number;
  dueDate: string;
  principalMinor: bigint;
  chargeMinor: bigint;
  totalMinor: bigint;
}

export interface QuoteResult {
  principalMinor: bigint;
  financeChargeMinor: bigint;
  totalPayableMinor: bigint;
  installments: readonly Installment[];
}

export const MAX_FINANCING_MINOR = 9_223_372_036_854_775_807n;
export const MAX_RATE_BASIS_POINTS = 1_000_000;

export function isSupportedTenure(value: number): value is SupportedTenure {
  return (SUPPORTED_TENURES as readonly number[]).includes(value);
}

export function assertSafeMinor(value: bigint, code: string): void {
  if (
    typeof value !== "bigint" ||
    value < 0n ||
    value > MAX_FINANCING_MINOR
  ) {
    throw new Error(code);
  }
}

export function assertRate(value: number): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_RATE_BASIS_POINTS
  ) {
    throw new Error("RATE_INVALID");
  }
}

