import { useEffect, useState } from "react";
import type { StaffPaymentsApi } from "../../lib/api.js";

export function PaymentWorkspace({
  api,
  actorId,
  roles,
}: {
  api: StaffPaymentsApi;
  actorId: string;
  roles: readonly string[];
}) {
  const [data, setData] = useState<{
    inbox: readonly Record<string, unknown>[];
    cases: readonly Record<string, unknown>[];
    settlements: readonly Record<string, unknown>[];
    adjustments: readonly Record<string, unknown>[];
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const canMakeAdjustment = roles.includes("FINANCE_OFFICER");
  const canCheckAdjustment =
    roles.includes("CFO") || roles.includes("COMPLIANCE_AUDITOR");

  useEffect(() => {
    let active = true;
    setData(null);
    setLoadError(false);
    void Promise.all([
      api.listPaymentInbox(),
      api.listReconciliationCases(),
      api.listSettlements(),
      api.listAdjustments(),
    ]).then(
      ([inbox, cases, settlements, adjustments]) => {
        if (active) setData({ inbox, cases, settlements, adjustments });
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (loadError)
    return (
      <p role="alert">We could not load payment reconciliation. Try again.</p>
    );
  if (data === null)
    return <p aria-busy="true">Loading payment reconciliation</p>;

  async function decide(adjustmentId: string, decision: "APPROVE" | "REJECT") {
    setActionError("");
    setNotice("");
    try {
      await api.decideAdjustment(adjustmentId, {
        decision,
        reason: `${decision === "APPROVE" ? "Approved" : "Rejected"} by ${actorId}`,
      });
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              adjustments: current.adjustments.map((item) =>
                item.id === adjustmentId
                  ? {
                      ...item,
                      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
                    }
                  : item,
              ),
            },
      );
      setNotice(
        decision === "APPROVE" ? "Adjustment approved" : "Adjustment rejected",
      );
    } catch {
      setActionError(
        "The adjustment could not be decided. Refresh and try again.",
      );
    }
  }

  return (
    <main className="staff-shell payment-workspace">
      <section className="panel" aria-labelledby="payments-title">
        <h1 id="payments-title">Payments reconciliation</h1>
        <p role="status">USSD and Mobile Money only. Cash is not accepted.</p>
      </section>
      <section className="panel" aria-labelledby="payment-inbox-title">
        <h2 id="payment-inbox-title">Payment inbox</h2>
        {data.inbox.length === 0 ? (
          <p>No payment events received.</p>
        ) : (
          <ul>
            {data.inbox.map((item, index) => (
              <li key={stringValue(item.id) ?? String(index)}>
                {stringValue(item.eventType) ?? "Payment event"} —{" "}
                {stringValue(item.providerEventId) ?? "unknown event"} —{" "}
                {stringValue(item.processedAt) === null
                  ? "pending"
                  : "processed"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="reconciliation-cases-title">
        <h2 id="reconciliation-cases-title">Unmatched and ambiguous events</h2>
        {data.cases.length === 0 ? (
          <p>No open reconciliation cases.</p>
        ) : (
          <ul>
            {data.cases.map((item, index) => (
              <li key={stringValue(item.id) ?? String(index)}>
                {stringValue(item.reason) ?? "Reconciliation case"} —{" "}
                {stringValue(item.status) ?? "OPEN"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="settlements-title">
        <h2 id="settlements-title">Settlement batches</h2>
        {data.settlements.length === 0 ? (
          <p>No settlement batches received.</p>
        ) : (
          <ul>
            {data.settlements.map((item, index) => (
              <li key={stringValue(item.id) ?? String(index)}>
                {stringValue(item.settlementReference) ?? "Settlement"} —{" "}
                {stringValue(item.status) ?? "PENDING"} — variance{" "}
                {stringValue(item.varianceMinorUnits) ?? "0"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="adjustments-title">
        <h2 id="adjustments-title">Maker-checker adjustments</h2>
        {data.adjustments.length === 0 ? (
          <p>No payment adjustments.</p>
        ) : (
          <ul>
            {data.adjustments.map((item, index) => {
              const id = stringValue(item.id) ?? String(index);
              const pending = item.status === "PENDING";
              const maker = stringValue(item.makerStaffUserId);
              return (
                <li key={id}>
                  <strong>
                    {stringValue(item.direction) ?? "ADJUSTMENT"}{" "}
                    {stringValue(item.amountMinorUnits) ?? ""}
                  </strong>{" "}
                  — {stringValue(item.reason) ?? "No reason"} — status{" "}
                  {stringValue(item.status) ?? "PENDING"}
                  {pending && canCheckAdjustment && maker !== actorId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void decide(id, "APPROVE")}
                      >
                        Approve adjustment
                      </button>
                      <button
                        type="button"
                        onClick={() => void decide(id, "REJECT")}
                      >
                        Reject adjustment
                      </button>
                    </>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {canMakeAdjustment ? (
        <AdjustmentRequestForm
          api={api}
          onSubmitted={(id) => {
            setNotice(`Adjustment ${id} requested`);
          }}
        />
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </main>
  );
}

function AdjustmentRequestForm({
  api,
  onSubmitted,
}: {
  api: StaffPaymentsApi;
  onSubmitted: (id: string) => void;
}) {
  const [contractId, setContractId] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  return (
    <section className="panel" aria-labelledby="adjustment-request-title">
      <h2 id="adjustment-request-title">Request an adjustment</h2>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          setError("");
          void api
            .requestAdjustment({
              contractId,
              amountMinorUnits: amount,
              direction: "CREDIT",
              reason,
              idempotencyKey: crypto.randomUUID(),
            })
            .then(
              (result) => {
                onSubmitted(result.id);
                setContractId("");
                setAmount("");
                setReason("");
              },
              () => setError("The adjustment request could not be saved."),
            );
        }}
      >
        <label>
          Contract ID
          <input
            value={contractId}
            onChange={(event) => setContractId(event.target.value)}
            required
          />
        </label>
        <label>
          Amount in minor units
          <input
            inputMode="numeric"
            pattern="[1-9][0-9]*"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            required
          />
        </label>
        <label>
          Reason
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            required
          />
        </label>
        <button type="submit">Request credit adjustment</button>
        {error ? <p role="alert">{error}</p> : null}
      </form>
    </section>
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
