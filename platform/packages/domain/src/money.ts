export type Currency = "GHS";

export type Money = Readonly<{
  currency: Currency;
  minorUnits: bigint;
}>;

export type MoneyDto = Readonly<{
  currency: Currency;
  minorUnits: string;
}>;

const MAX_SIGNED_64_BIT = 9_223_372_036_854_775_807n;
const DECIMAL_INTEGER = /^(0|[1-9]\d*)$/;

function assertMoney(money: Money): void {
  if (money.currency !== "GHS") {
    throw new Error("MONEY_CURRENCY_NOT_SUPPORTED");
  }

  if (
    typeof money.minorUnits !== "bigint" ||
    money.minorUnits < 0n ||
    money.minorUnits > MAX_SIGNED_64_BIT
  ) {
    throw new Error("MONEY_VALUE_OUT_OF_RANGE");
  }
}

function assertMatchingCurrency(left: Money, right: Money): void {
  if (left.currency !== right.currency) {
    throw new Error("MONEY_CURRENCY_MISMATCH");
  }
}

export function ghs(minorUnits: bigint): Money {
  const money: Money = { currency: "GHS", minorUnits };
  assertMoney(money);
  return money;
}

export function addMoney(left: Money, right: Money): Money {
  assertMoney(left);
  assertMoney(right);
  assertMatchingCurrency(left, right);
  return ghs(left.minorUnits + right.minorUnits);
}

export function subtractMoney(left: Money, right: Money): Money {
  assertMoney(left);
  assertMoney(right);
  assertMatchingCurrency(left, right);
  return ghs(left.minorUnits - right.minorUnits);
}

export function compareMoney(left: Money, right: Money): -1 | 0 | 1 {
  assertMoney(left);
  assertMoney(right);
  assertMatchingCurrency(left, right);

  if (left.minorUnits < right.minorUnits) {
    return -1;
  }

  if (left.minorUnits > right.minorUnits) {
    return 1;
  }

  return 0;
}

export function toMoneyDto(money: Money): MoneyDto {
  assertMoney(money);
  return { currency: money.currency, minorUnits: money.minorUnits.toString() };
}

export function fromMoneyDto(dto: MoneyDto): Money {
  if (dto.currency !== "GHS") {
    throw new Error("MONEY_CURRENCY_NOT_SUPPORTED");
  }

  if (!DECIMAL_INTEGER.test(dto.minorUnits)) {
    throw new Error("MONEY_DTO_INVALID");
  }

  return ghs(BigInt(dto.minorUnits));
}
