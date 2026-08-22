import { useEffect, useState } from "react";

export interface CustomerAccountStatus {
  contractId: string;
  contractStatus: string;
  outstandingBalanceMinorUnits: string;
  nextDueDate: string | null;
  overdueMinorUnits: string;
  consecutiveMissedPayments: number;
  totalUnpaidPayments: number;
  signals: readonly string[];
  cashAccepted: false;
  paymentInstructions?: string | null;
  paymentLink?: string | null;
}

export interface CustomerReminder {
  id: string;
  status: string;
  message?: string;
  template?: string;
  createdAt: string;
}

export interface CustomerCollectionsApi {
  getAccountStatus(): Promise<readonly CustomerAccountStatus[]>;
  listReminders(): Promise<readonly CustomerReminder[]>;
}

export function AccountStatusPanel({ api }: { api: CustomerCollectionsApi }) {
  const [accounts, setAccounts] = useState<
    readonly CustomerAccountStatus[] | null
  >(null);
  const [reminders, setReminders] = useState<
    readonly CustomerReminder[] | null
  >(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setAccounts(null);
    setReminders(null);
    setError(false);
    void Promise.all([api.getAccountStatus(), api.listReminders()]).then(
      ([loadedAccounts, loadedReminders]) => {
        if (!active) return;
        setAccounts(loadedAccounts);
        setReminders(loadedReminders);
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
      <p role="alert">We could not load your account status. Try again.</p>
    );
  if (accounts === null || reminders === null)
    return <p aria-busy="true">Loading account status</p>;

  if (accounts.length === 0)
    return (
      <section
        className="panel account-status-panel"
        aria-labelledby="account-status-title"
      >
        <h1 id="account-status-title">Account status</h1>
        <p>No active customer accounts were found.</p>
      </section>
    );

  return (
    <section
      className="panel account-status-panel"
      aria-labelledby="account-status-title"
    >
      <h1 id="account-status-title">Account status</h1>
      {accounts.map((status) => (
        <article
          key={status.contractId}
          aria-labelledby={`account-${status.contractId}`}
        >
          <h2 id={`account-${status.contractId}`}>{status.contractId}</h2>
          <p role="status">Contract status: {status.contractStatus}</p>
          <p>
            Outstanding balance:{" "}
            {formatGhs(status.outstandingBalanceMinorUnits)}
          </p>
          <p>Next due date: {status.nextDueDate ?? "No upcoming due date"}</p>
          <p>Overdue amount: {formatGhs(status.overdueMinorUnits)}</p>
          <p>{status.consecutiveMissedPayments} consecutive missed payments</p>
          <p>{status.totalUnpaidPayments} total unpaid payments</p>
          {status.signals.length > 0 ? (
            <section aria-labelledby={`account-signals-${status.contractId}`}>
              <h3 id={`account-signals-${status.contractId}`}>
                Payment signals
              </h3>
              <ul>
                {status.signals.map((signal) => (
                  <li key={signal}>{signal}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <section
            aria-labelledby={`payment-instructions-${status.contractId}`}
          >
            <h3 id={`payment-instructions-${status.contractId}`}>How to pay</h3>
            {status.paymentInstructions === undefined ||
            status.paymentInstructions === null ? (
              <p>Payment instructions are currently unavailable.</p>
            ) : (
              <p>{status.paymentInstructions}</p>
            )}
            {status.paymentLink === undefined ||
            status.paymentLink === null ? null : (
              <a href={status.paymentLink}>Open secure payment account</a>
            )}
          </section>
          <p role="status">Cash is not accepted.</p>
        </article>
      ))}
      <section aria-labelledby="reminders-title">
        <h2 id="reminders-title">Payment reminders</h2>
        {reminders.length === 0 ? (
          <p>No payment reminders.</p>
        ) : (
          <ul>
            {reminders.map((reminder) => (
              <li key={reminder.id}>
                {reminder.message ?? reminder.template ?? "Payment reminder"} —{" "}
                {reminder.status} — {reminder.createdAt}
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
  return "GHS " + major + "." + cents;
}
