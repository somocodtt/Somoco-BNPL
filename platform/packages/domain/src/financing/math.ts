export function roundHalfUp(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new Error("ROUNDING_DENOMINATOR_INVALID");
  if (numerator < 0n) {
    return -roundHalfUp(-numerator, denominator);
  }
  const quotient = numerator / denominator;
  const remainder = numerator % denominator;
  return remainder * 2n >= denominator ? quotient + 1n : quotient;
}

export function powBigInt(base: bigint, exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0) {
    throw new Error("EXPONENT_INVALID");
  }
  let result = 1n;
  let factor = base;
  let remaining = exponent;
  while (remaining > 0) {
    if (remaining % 2 === 1) result *= factor;
    remaining = Math.floor(remaining / 2);
    if (remaining > 0) factor *= factor;
  }
  return result;
}

export function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

