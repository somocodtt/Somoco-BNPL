import { useEffect, useState } from "react";

export interface StaffCollectionsApi {
  listArrears(): Promise<readonly Record<string, unknown>[]>;
  listCases(): Promise<readonly Record<string, unknown>[]>;
  decideRecoveryCase(
    recoveryCaseId: string,
    input: {
      decision: "APPROVED" | "DENIED";
      purpose: string;
      reason: string;
      idempotencyKey: string;
    },
  ): Promise<Record<string, unknown>>;
  getRecoveryLocation(
    recoveryCaseId: string,
    purpose: string,
  ): Promise<Record<string, unknown>>;
}

export function CollectionsWorkspace({
  api,
  actorId,
}: {
  api: StaffCollectionsApi;
  actorId: string;
}) {
  const [data, setData] = useState<{
    arrears: readonly Record<string, unknown>[];
    cases: readonly Record<string, unknown>[];
  } | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");
  const [location, setLocation] = useState<Record<string, unknown>>({});

  useEffect(() => {
    let active = true;
    setData(null);
    setLoadError(false);
    void Promise.all([api.listArrears(), api.listCases()]).then(
      ([arrears, cases]) => {
        if (active) setData({ arrears, cases });
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
    return <p role="alert">We could not load collections. Try again.</p>;
  if (data === null) return <p aria-busy="true">Loading collections queue</p>;

  async function decideRecoveryCase(
    recoveryCaseId: string,
    decision: "APPROVED" | "DENIED",
  ) {
    setActionError("");
    setNotice("");
    try {
      await api.decideRecoveryCase(recoveryCaseId, {
        decision,
        purpose: "Human recovery review",
        reason:
          (decision === "APPROVED" ? "Approved" : "Denied") + " by " + actorId,
        idempotencyKey: crypto.randomUUID(),
      });
      setData((current) =>
        current === null
          ? current
          : {
              ...current,
              cases: current.cases.map((item) =>
                item.id === recoveryCaseId
                  ? {
                      ...item,
                      status:
                        decision === "APPROVED" ? "IN_PROGRESS" : "CLOSED",
                    }
                  : item,
              ),
            },
      );
      setNotice(
        decision === "APPROVED"
          ? "Recovery case approved"
          : "Recovery case denied",
      );
    } catch {
      setActionError("The recovery decision could not be saved.");
    }
  }

  async function lookupLocation(recoveryCaseId: string) {
    setActionError("");
    setNotice("");
    try {
      const result = await api.getRecoveryLocation(
        recoveryCaseId,
        "Authorized recovery review",
      );
      setLocation((current) => ({ ...current, [recoveryCaseId]: result }));
      setNotice("Location lookup recorded for audit");
    } catch {
      setActionError("The authorized location lookup could not be completed.");
    }
  }

  return (
    <main className="staff-shell collections-workspace">
      <section className="panel" aria-labelledby="collections-title">
        <h1 id="collections-title">Arrears and recovery</h1>
        <p role="status">Signals are reported for human review only.</p>
        <p>No automatic vehicle action is taken.</p>
      </section>
      <section className="panel" aria-labelledby="arrears-title">
        <h2 id="arrears-title">Arrears signals</h2>
        {data.arrears.length === 0 ? (
          <p>No arrears signals.</p>
        ) : (
          <ul>
            {data.arrears.map((item, index) => (
              <li key={stringValue(item.id) ?? String(index)}>
                {stringValue(item.signal) ?? "Arrears signal"} —{" "}
                {stringValue(item.unpaidCount) ?? "0"} unpaid —{" "}
                {stringValue(item.asOfDate) ?? "date unavailable"}
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="recovery-cases-title">
        <h2 id="recovery-cases-title">Human recovery cases</h2>
        {data.cases.length === 0 ? (
          <p>No recovery cases.</p>
        ) : (
          <ul>
            {data.cases.map((item, index) => {
              const id = stringValue(item.id) ?? String(index);
              const status = stringValue(item.status) ?? "OPEN";
              const maker = stringValue(item.makerStaffUserId);
              const pending = status === "OPEN" || status === "PENDING";
              return (
                <li key={id}>
                  <strong>{stringValue(item.contractId) ?? "Contract"}</strong>{" "}
                  — {status} —{" "}
                  {stringValue(item.purpose) ?? "Human recovery review"}
                  {pending && maker !== actorId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => void decideRecoveryCase(id, "APPROVED")}
                      >
                        Approve recovery case
                      </button>
                      <button
                        type="button"
                        onClick={() => void decideRecoveryCase(id, "DENIED")}
                      >
                        Deny recovery case
                      </button>
                    </>
                  ) : null}
                  {status === "IN_PROGRESS" ? (
                    <button
                      type="button"
                      onClick={() => void lookupLocation(id)}
                    >
                      View authorized location
                    </button>
                  ) : null}
                  {location[id] ? (
                    <output>
                      Location:{" "}
                      {stringValue(
                        (location[id] as Record<string, unknown>).latitude,
                      ) ?? "unavailable"}
                      ,{" "}
                      {stringValue(
                        (location[id] as Record<string, unknown>).longitude,
                      ) ?? "unavailable"}
                    </output>
                  ) : null}
                  {Array.isArray(item.decisions) &&
                  item.decisions.length > 0 ? (
                    <ul aria-label={`Decision history for ${id}`}>
                      {(item.decisions as Record<string, unknown>[]).map(
                        (decision, decisionIndex) => (
                          <li
                            key={
                              stringValue(decision.id) ?? String(decisionIndex)
                            }
                          >
                            Decision:{" "}
                            {stringValue(decision.decision) ?? "unknown"} —
                            checker{" "}
                            {stringValue(decision.checkerStaffUserId) ??
                              "unknown"}
                          </li>
                        ),
                      )}
                    </ul>
                  ) : null}
                  {Array.isArray(item.actions) && item.actions.length > 0 ? (
                    <ul aria-label={`Action history for ${id}`}>
                      {(item.actions as Record<string, unknown>[]).map(
                        (action, actionIndex) => (
                          <li
                            key={stringValue(action.id) ?? String(actionIndex)}
                          >
                            Action:{" "}
                            {stringValue(action.actionType) ?? "unknown"} —{" "}
                            {stringValue(action.purpose) ??
                              "purpose unavailable"}
                          </li>
                        ),
                      )}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {actionError ? <p role="alert">{actionError}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </main>
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}
