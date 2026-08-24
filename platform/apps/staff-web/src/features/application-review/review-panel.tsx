import { useState } from "react";
import type {
  ApplicationDetail,
  DecisionAction,
  StaffApi,
} from "../../lib/api.js";

const stageForStatus: Record<string, string> = {
  VERIFICATION_REVIEW: "VERIFICATION",
  BSM_INITIAL_REVIEW: "BSM_INITIAL",
  AGM_REVIEW: "AGM",
  CFO_REVIEW: "CFO",
  BSM_FINAL_REVIEW: "BSM_FINAL",
  MD_REVIEW: "MD",
};

export function ReviewPanel({
  api,
  detail,
  onDecisionSaved,
  onBack,
}: {
  api: StaffApi;
  detail: ApplicationDetail;
  onDecisionSaved: (result: {
    action: DecisionAction;
    status: string;
    version: number;
  }) => void;
  onBack: () => void;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<DecisionAction | null>(null);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const snapshot = detail.snapshot;
  const stage = stageForStatus[detail.status] ?? "";

  async function decide(action: DecisionAction) {
    setPending(action);
    setError("");
    setConflict(false);
    try {
      const result = await api.decide(detail.id, {
        action,
        stage,
        expectedVersion: detail.version,
        note: note.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      onDecisionSaved({ ...result, action });
    } catch (caught) {
      const code =
        typeof caught === "object" && caught !== null && "code" in caught
          ? String((caught as { code: unknown }).code)
          : "REQUEST_FAILED";
      if (code === "STALE_VERSION" || code === "VERSION_CONFLICT") {
        setConflict(true);
        setError(
          "This application is stale. Refresh the review before deciding.",
        );
      } else {
        setError("We could not save this decision. Try again.");
      }
    } finally {
      setPending(null);
    }
  }

  const nia = record(snapshot.nia);
  const documents = record(snapshot.documents);
  const statements = Array.isArray(snapshot.statements)
    ? snapshot.statements
    : [];

  return (
    <section className="panel review-panel" aria-labelledby="review-title">
      <button type="button" onClick={onBack}>
        Back to queue
      </button>
      <h1 id="review-title">Application review</h1>
      <p role="status">
        Current status: {detail.status} · Version {detail.version}
      </p>
      <section aria-labelledby="snapshot-title">
        <h2 id="snapshot-title">Immutable applicant snapshot</h2>
        <dl>
          <dt>Applicant</dt>
          <dd>{String(snapshot.applicantName ?? "Not provided")}</dd>
          <dt>NIA</dt>
          <dd>{`NIA: ${String(nia.status ?? "NOT CHECKED")}${nia.reference ? ` (${String(nia.reference)})` : ""}`}</dd>
          <dt>Documents</dt>
          <dd>{`Document scan: ${String(documents.scanState ?? "UNKNOWN")}`}</dd>
        </dl>
      </section>
      <section aria-labelledby="evidence-title">
        <h2 id="evidence-title">Statements and evidence</h2>
        {statements.length === 0 ? (
          <p>No statements or evidence recorded.</p>
        ) : (
          <ul>
            {statements.map((statement, index) => (
              <li key={index}>{formatEvidence(statement)}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="bureau-title">
        <h2 id="bureau-title">Manual bureau evidence</h2>
        {detail.underwriting.length === 0 ? (
          <p>No manual credit-bureau check recorded.</p>
        ) : (
          <ul>
            {detail.underwriting.map((item, index) => (
              <li key={index}>{formatEvidence(item.assessment ?? item)}</li>
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="history-title">
        <h2 id="history-title">Prior decisions</h2>
        {detail.decisions.length === 0 ? (
          <p>No prior decisions.</p>
        ) : (
          <ol>
            {detail.decisions.map((decision, index) => (
              <li key={index}>{formatEvidence(decision)}</li>
            ))}
          </ol>
        )}
      </section>
      {stage ? (
        <section aria-labelledby="decision-title">
          <h2 id="decision-title">Decision</h2>
          <label htmlFor="decision-note">Decision note</label>
          <textarea
            id="decision-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={4}
          />
          {error ? <p role="alert">{error}</p> : null}
          {conflict ? (
            <button type="button" onClick={() => window.location.reload()}>
              Refresh stale application
            </button>
          ) : null}
          <div className="decision-actions">
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void decide("APPROVE")}
            >
              {pending === "APPROVE" ? "Saving…" : "Approve application"}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void decide("REQUEST_INFORMATION")}
            >
              {pending === "REQUEST_INFORMATION"
                ? "Saving…"
                : "Request information"}
            </button>
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void decide("REJECT")}
            >
              {pending === "REJECT" ? "Saving…" : "Reject application"}
            </button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function formatEvidence(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${String(item)}`)
      .join(" · ");
  }
  return String(value);
}
