import { useEffect, useState } from "react";

export interface ProductRuleSummary {
  id: string;
  versionNumber: number;
  status: "DRAFT" | "PUBLISHED";
  requestedBy: string | null;
  effectiveFrom: string | null;
  gate: "OPEN" | "CLOSED";
}

export interface StaffExceptionSummary {
  id: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  requestedBy: string;
  requiredApproverRole: string;
  proposedValue: unknown;
  policyValue: unknown;
  reason: string;
  version: number;
}

export interface ProductApi {
  listRules(): Promise<ProductRuleSummary[]>;
  listExceptions(): Promise<StaffExceptionSummary[]>;
  publish(ruleId: string, input: { idempotencyKey: string }): Promise<void>;
  decideException(
    exceptionId: string,
    input: { expectedVersion: number; decision: "APPROVE" | "REJECT" },
  ): Promise<void>;
}

export function ProductWorkspace({
  api,
  actorId,
}: {
  api: ProductApi;
  actorId: string;
}) {
  const [rules, setRules] = useState<ProductRuleSummary[] | null>(null);
  const [exceptions, setExceptions] = useState<StaffExceptionSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setRules(null);
    setExceptions(null);
    setLoadError(false);
    void Promise.all([api.listRules(), api.listExceptions()]).then(
      ([loadedRules, loadedExceptions]) => {
        if (!active) return;
        setRules(loadedRules);
        setExceptions(loadedExceptions);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (rules === null || exceptions === null) {
    return <p aria-busy="true">Loading product controls</p>;
  }
  if (loadError) {
    return <p role="alert">We could not load product controls. Try again.</p>;
  }
  const gateClosed = rules.every((rule) => rule.gate === "CLOSED") || rules.length === 0;
  return (
    <main className="staff-shell product-workspace">
      <section className="panel" aria-labelledby="products-title">
        <h1 id="products-title">Financing products</h1>
        <p role={gateClosed ? "alert" : "status"}>
          Finance and Compliance fixture gate: {gateClosed ? "closed" : "open"}
        </p>
        {gateClosed ? <p>No approved fixtures are registered.</p> : null}
        {rules.length === 0 ? (
          <p>No product rule versions are configured.</p>
        ) : (
          <ul>
            {rules.map((rule) => {
              const requester = rule.requestedBy === null ? "unknown maker" : rule.requestedBy;
              const canPublish =
                rule.status === "DRAFT" &&
                !gateClosed &&
                rule.requestedBy !== actorId;
              return (
                <li key={rule.id}>
                  <strong>Rule version {rule.versionNumber}</strong>
                  <span>Requested by {requester}</span>
                  {rule.effectiveFrom ? <time dateTime={rule.effectiveFrom}>{rule.effectiveFrom}</time> : null}
                  <button
                    type="button"
                    disabled={!canPublish}
                    onClick={() => {
                      setActionError("");
                      setNotice("");
                      void api
                        .publish(rule.id, { idempotencyKey: crypto.randomUUID() })
                        .then(() => setNotice("Rule version published"))
                        .catch(() => setActionError("This rule is stale or the fixture gate is closed."));
                    }}
                  >
                    Publish rule version
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section className="panel" aria-labelledby="exceptions-title">
        <h2 id="exceptions-title">Controlled exceptions</h2>
        {exceptions.length === 0 ? (
          <p>No pending controlled exceptions.</p>
        ) : (
          <ul>
            {exceptions.map((exception) => {
              const requester = exception.requestedBy === actorId;
              return (
                <li key={exception.id}>
                  <strong>{exception.reason}</strong>
                  <span>Required authority: {exception.requiredApproverRole}</span>
                  <span>Proposed value: {String(exception.proposedValue)}</span>
                  <span>Policy value: {String(exception.policyValue)}</span>
                  <button
                    type="button"
                    disabled={requester}
                    onClick={() => decide(exception, "APPROVE")}
                  >
                    Approve exception
                  </button>
                  <button
                    type="button"
                    disabled={requester}
                    onClick={() => decide(exception, "REJECT")}
                  >
                    Reject exception
                  </button>
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

  function decide(exception: StaffExceptionSummary, decision: "APPROVE" | "REJECT") {
    setActionError("");
    setNotice("");
    void api
      .decideException(exception.id, { expectedVersion: exception.version, decision })
      .then(() => setNotice(decision === "APPROVE" ? "Exception approved" : "Exception rejected"))
      .catch((error: unknown) => {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? String((error as { code: unknown }).code)
            : "";
        setActionError(
          code === "STALE_VERSION"
            ? "Refresh the exception before deciding."
            : "The exception could not be decided.",
        );
      });
  }
}

