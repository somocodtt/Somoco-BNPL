import { calculateFlatMarkup, type FlatMarkupQuote } from "./flat-markup.js";
import {
  calculateReducingBalance,
  type ReducingBalanceQuote,
} from "./reducing-balance.js";
import {
  assertRate,
  assertSafeMinor,
  isSupportedTenure,
  type QuoteInput,
  type QuoteResult,
} from "./types.js";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export class FinancingEngine {
  static quote(input: QuoteInput): QuoteResult {
    return quote(input);
  }

  quote(input: QuoteInput): QuoteResult {
    return quote(input);
  }
}

export function quote(input: QuoteInput): QuoteResult {
  assertInput(input);
  const principalMinor = input.priceMinor - input.depositMinor;
  const dueDates = buildDueDates(
    input.firstDueDate,
    input.frequency,
    input.tenureMonths,
  );
  const calculated: FlatMarkupQuote | ReducingBalanceQuote =
    input.pricing.method === "FLAT_MARKUP"
      ? calculateFlatMarkup(
          principalMinor,
          input.pricing.markupBasisPoints,
          dueDates,
        )
      : calculateReducingBalance(
          principalMinor,
          input.pricing.annualRateBasisPoints,
          input.frequency,
          dueDates,
        );
  assertSafeMinor(principalMinor, "PRINCIPAL_OUT_OF_RANGE");
  assertSafeMinor(calculated.financeChargeMinor, "CHARGE_OUT_OF_RANGE");
  assertSafeMinor(calculated.totalPayableMinor, "TOTAL_OUT_OF_RANGE");
  for (const item of calculated.installments) {
    assertSafeMinor(item.principalMinor, "INSTALLMENT_OUT_OF_RANGE");
    assertSafeMinor(item.chargeMinor, "INSTALLMENT_OUT_OF_RANGE");
    assertSafeMinor(item.totalMinor, "INSTALLMENT_OUT_OF_RANGE");
  }
  return {
    principalMinor,
    financeChargeMinor: calculated.financeChargeMinor,
    totalPayableMinor: calculated.totalPayableMinor,
    installments: calculated.installments,
  };
}

export function buildDueDates(
  firstDueDate: string,
  frequency: "WEEKLY" | "MONTHLY",
  tenureMonths: 6 | 8 | 12 | 24 | 36 | 48,
): readonly string[] {
  const count =
    frequency === "MONTHLY"
      ? tenureMonths
      : Math.ceil((tenureMonths * 52) / 12);
  const dates: string[] = [];
  for (let index = 0; index < count; index += 1) {
    dates.push(
      frequency === "MONTHLY"
        ? addCalendarMonths(firstDueDate, index)
        : addCalendarWeeks(firstDueDate, index),
    );
  }
  return dates;
}

export function addCalendarMonths(isoDate: string, months: number): string {
  const parsed = parseIsoDate(isoDate);
  const absoluteMonth = parsed.year * 12 + (parsed.month - 1) + months;
  const year = Math.floor(absoluteMonth / 12);
  const month = (((absoluteMonth % 12) + 12) % 12) + 1;
  const day = Math.min(parsed.day, daysInMonth(year, month));
  return formatDate(year, month, day);
}

export function addCalendarWeeks(isoDate: string, weeks: number): string {
  const parsed = parseIsoDate(isoDate);
  return formatCivilDate(
    civilFromDays(
      daysFromCivil(parsed.year, parsed.month, parsed.day) + weeks * 7,
    ),
  );
}

export function assertInput(input: QuoteInput): void {
  if (typeof input !== "object" || input === null) {
    throw new Error("QUOTE_INPUT_INVALID");
  }
  assertSafeMinor(input.priceMinor, "PRICE_INVALID");
  assertSafeMinor(input.depositMinor, "DEPOSIT_INVALID");
  if (input.depositMinor > input.priceMinor) {
    throw new Error("DEPOSIT_EXCEEDS_PRICE");
  }
  if (input.frequency !== "WEEKLY" && input.frequency !== "MONTHLY") {
    throw new Error("FREQUENCY_NOT_SUPPORTED");
  }
  if (!isSupportedTenure(input.tenureMonths)) {
    throw new Error("TENURE_NOT_SUPPORTED");
  }
  if (input.pricing?.method === "FLAT_MARKUP") {
    assertRate(input.pricing.markupBasisPoints);
  } else if (input.pricing?.method === "REDUCING_BALANCE") {
    assertRate(input.pricing.annualRateBasisPoints);
  } else {
    throw new Error("METHOD_NOT_SUPPORTED");
  }
  parseIsoDate(input.firstDueDate);
}

interface DateParts {
  year: number;
  month: number;
  day: number;
}

function parseIsoDate(value: string): DateParts {
  const match = ISO_DATE.exec(value);
  if (match === null) throw new Error("DATE_INVALID");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    throw new Error("DATE_INVALID");
  }
  return { year, month, day };
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysFromCivil(year: number, month: number, day: number): number {
  const adjustedYear = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const dayOfYear =
    Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 +
    Math.floor(yearOfEra / 4) -
    Math.floor(yearOfEra / 100) +
    dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

function civilFromDays(days: number): DateParts {
  const shifted = days + 719468;
  const era = Math.floor(shifted / 146097);
  const dayOfEra = shifted - era * 146097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1460) +
      Math.floor(dayOfEra / 36524) -
      Math.floor(dayOfEra / 146096)) /
      365,
  );
  let year = yearOfEra + era * 400;
  const dayOfYear =
    dayOfEra -
    (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const monthPart = Math.floor((5 * dayOfYear + 2) / 153);
  const day = dayOfYear - Math.floor((153 * monthPart + 2) / 5) + 1;
  const month = monthPart + (monthPart < 10 ? 3 : -9);
  year += month <= 2 ? 1 : 0;
  return { year, month, day };
}

function formatCivilDate(parts: DateParts): string {
  return formatDate(parts.year, parts.month, parts.day);
}
