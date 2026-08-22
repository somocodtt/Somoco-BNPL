export interface ArrearsInstallment {
  readonly installmentNumber: number;
  readonly dueDate: string;
  readonly amountMinor: bigint;
  /** Net posted ledger allocation after any immutable reversals. */
  readonly postedMinor: bigint;
}

export interface ComputeArrearsInput {
  readonly asOfDate: string;
  readonly installments: readonly ArrearsInstallment[];
}

export interface ArrearsResult {
  readonly asOfDate: string;
  readonly overdueMinor: bigint;
  readonly consecutiveMissed: number;
  readonly totalUnpaid: number;
  readonly escalationSignals: readonly (
    "THREE_CONSECUTIVE_MISSED" | "THREE_TOTAL_UNPAID"
  )[];
}

export function computeArrears(input: ComputeArrearsInput): ArrearsResult {
  assertDate(input.asOfDate, "ARREARS_DATE_INVALID");
  const rows = input.installments.map((item) => {
    if (
      !Number.isSafeInteger(item.installmentNumber) ||
      item.installmentNumber < 1
    )
      throw new Error("ARREARS_INSTALLMENT_NUMBER_INVALID");
    assertDate(item.dueDate, "ARREARS_DUE_DATE_INVALID");
    if (item.amountMinor < 0n) throw new Error("ARREARS_AMOUNT_INVALID");
    if (item.postedMinor < 0n || item.postedMinor > item.amountMinor)
      throw new Error("ARREARS_POSTED_INVALID");
    return item;
  });
  const numbers = new Set<number>();
  for (const item of rows) {
    if (numbers.has(item.installmentNumber))
      throw new Error("ARREARS_INSTALLMENT_DUPLICATE");
    numbers.add(item.installmentNumber);
  }
  rows.sort((left, right) => left.installmentNumber - right.installmentNumber);
  const due = rows.filter((item) => item.dueDate <= input.asOfDate);
  let overdueMinor = 0n;
  let totalUnpaid = 0;
  for (const item of due) {
    const unpaid = item.amountMinor - item.postedMinor;
    overdueMinor += unpaid;
    if (unpaid > 0n) totalUnpaid += 1;
  }
  let consecutiveMissed = 0;
  let currentRun = 0;
  for (const item of due) {
    if (item.amountMinor - item.postedMinor === 0n) {
      currentRun = 0;
      continue;
    }
    currentRun += 1;
    consecutiveMissed = Math.max(consecutiveMissed, currentRun);
  }
  const escalationSignals: Array<
    "THREE_CONSECUTIVE_MISSED" | "THREE_TOTAL_UNPAID"
  > = [];
  if (consecutiveMissed >= 3)
    escalationSignals.push("THREE_CONSECUTIVE_MISSED");
  if (totalUnpaid >= 3) escalationSignals.push("THREE_TOTAL_UNPAID");
  return Object.freeze({
    asOfDate: input.asOfDate,
    overdueMinor,
    consecutiveMissed,
    totalUnpaid,
    escalationSignals: Object.freeze(escalationSignals),
  });
}

function assertDate(value: string, code: string): void {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) throw new Error(code);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const days =
    month === 2
      ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
        ? 29
        : 28
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days)
    throw new Error(code);
}
