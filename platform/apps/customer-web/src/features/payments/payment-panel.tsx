import { useEffect, useState } from "react";
import type {
  CustomerPaymentAccount,
  CustomerPaymentInstructions,
  CustomerPaymentRecord,
  CustomerPaymentsApi,
  CustomerReceiptRecord,
} from "../../lib/api.js";

export function PaymentPanel({ api }: { api: CustomerPaymentsApi }) {
  const [instructions, setInstructions] =
    useState<CustomerPaymentInstructions | null>(null);
  const [payments, setPayments] = useState<
    readonly CustomerPaymentRecord[] | null
  >(null);
  const [accounts, setAccounts] = useState<
    readonly CustomerPaymentAccount[] | null
  >(null);
  const [receipts, setReceipts] = useState<
    readonly CustomerReceiptRecord[] | null
  >(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setInstructions(null);
    setAccounts(null);
    setPayments(null);
    setReceipts(null);
    setError(false);
    void Promise.all([
      api.getPaymentInstructions(),
      api.getPaymentAccounts(),
      api.getPayments(),
      api.getReceipts(),
    ]).then(
      ([
        loadedInstructions,
        loadedAccounts,
        loadedPayments,
        loadedReceipts,
      ]) => {
        if (!active) return;
        setInstructions(loadedInstructions);
        setAccounts(loadedAccounts);
        setPayments(loadedPayments);
        setReceipts(loadedReceipts);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (error)
    return (
      <p role="alert">We could not load your payment account. Try again.</p>
    );
  if (
    instructions === null ||
    accounts === null ||
    payments === null ||
    receipts === null
  )
    return <p aria-busy="true">Loading payment account</p>;

  const accountBalance = accounts[0]?.outstandingBalanceMinorUnits ?? "0";
  const nextDueDate = accounts[0]?.nextDueDate ?? null;
  return (
    <section className="panel payment-panel" aria-labelledby="payment-title">
      <h1 id="payment-title">Payments and receipts</h1>
      <p role="status">Payment channel: USSD and Mobile Money only.</p>
      <p>Outstanding balance: {formatGhs(accountBalance)}</p>
      <p>Next due date: {nextDueDate ?? "No upcoming due date"}</p>
      <section aria-labelledby="payment-instructions-title">
        <h2 id="payment-instructions-title">How to pay</h2>
        <p>{instructions.ussdInstructions}</p>
      </section>
      <section aria-labelledby="payment-history-title">
        <h2 id="payment-history-title">Posted payments</h2>
        {payments.length === 0 ? (
          <p role="status">No posted payments yet.</p>
        ) : (
          <ul>
            {payments.map((payment) => (
              <li key={payment.id}>
                {formatGhs(payment.amountMinorUnits)} — {payment.occurredAt} —{" "}
                {payment.status}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="payment-receipts-title">
        <h2 id="payment-receipts-title">Electronic receipts</h2>
        {receipts.length === 0 ? (
          <p role="status">No receipts yet.</p>
        ) : (
          <ul>
            {receipts.map((receipt) => (
              <li key={receipt.id}>
                <a href={receipt.securePath}>{receipt.receiptNumber}</a> —{" "}
                {formatGhs(receipt.amountMinorUnits)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </section>
  );
}

function formatGhs(minor: string): string {
  if (!/^\d+$/.test(minor)) return "GHS —";
  const major = minor.slice(0, -2) || "0";
  const cents = minor.slice(-2).padStart(2, "0");
  return `GHS ${major}.${cents}`;
}
