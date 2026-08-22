import { useEffect, useState } from "react";
import type { StaffMigrationApi, StaffReportsApi } from "../../lib/api.js";

export function ReportsWorkspace({
  api,
  migrationApi,
  roles,
}: {
  api: StaffReportsApi;
  migrationApi?: StaffMigrationApi;
  roles: readonly string[];
}) {
  const [report, setReport] = useState<Record<string, unknown> | null>(null);
  const [batches, setBatches] = useState<
    readonly Record<string, unknown>[] | null
  >(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let active = true;
    setReport(null);
    setBatches(null);
    setError("");
    void api.getReport("operations").then(
      (value) => {
        if (active) setReport(value);
      },
      () => {
        if (active) setError("We could not load operational reporting.");
      },
    );
    if (migrationApi !== undefined) {
      void migrationApi.listBatches().then(
        (value) => {
          if (active) setBatches(value);
        },
        () => {
          if (active) setError("We could not load migration batches.");
        },
      );
    }
    return () => {
      active = false;
    };
  }, [api, migrationApi]);

  if (error) return <p role="alert">{error}</p>;
  if (report === null)
    return <p aria-busy="true">Loading operational reporting</p>;

  const rows = Array.isArray(report.rows) ? report.rows.filter(isRecord) : [];
  return (
    <main className="staff-shell reports-workspace">
      <section className="panel" aria-labelledby="reports-title">
        <h1 id="reports-title">Operations and portfolio reporting</h1>
        <p role="status">
          Server-enforced classification:{" "}
          {stringValue(report.dataClassification) ?? "REDACTED"}
        </p>
        <button
          type="button"
          onClick={() => {
            setNotice("");
            void api.exportReport({ report: "operations", format: "CSV" }).then(
              (value) =>
                setNotice(
                  `Export ${stringValue(value.id) ?? "created"} attributed to the requester.`,
                ),
              () => setNotice("The export could not be created."),
            );
          }}
        >
          Export operations CSV
        </button>
        {notice ? <p role="status">{notice}</p> : null}
      </section>
      <ReportTable title="Operational queue" rows={rows} />
      <section className="panel" aria-labelledby="report-summary-title">
        <h2 id="report-summary-title">Migration totals</h2>
        <pre>{JSON.stringify(report.migrationTotals ?? {}, null, 2)}</pre>
      </section>
      {migrationApi !== undefined ? (
        <MigrationPanel api={migrationApi} batches={batches} roles={roles} />
      ) : null}
    </main>
  );
}

function ReportTable({
  title,
  rows,
}: {
  title: string;
  rows: readonly Record<string, unknown>[];
}) {
  return (
    <section className="panel" aria-labelledby="report-table-title">
      <h2 id="report-table-title">{title}</h2>
      {rows.length === 0 ? (
        <p>No records match the selected report filters.</p>
      ) : (
        <ul>
          {rows.map((row, index) => (
            <li
              key={
                stringValue(row.applicationId) ??
                stringValue(row.contractId) ??
                String(index)
              }
            >
              {stringValue(row.status) ?? "Unknown"} — balance{" "}
              {stringValue(row.currentBalanceMinorUnits) ?? "0"} — consecutive
              missed {stringValue(row.consecutiveMissed) ?? "0"} — total unpaid{" "}
              {stringValue(row.totalUnpaid) ?? "0"}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MigrationPanel({
  api,
  batches,
  roles,
}: {
  api: StaffMigrationApi;
  batches: readonly Record<string, unknown>[] | null;
  roles: readonly string[];
}) {
  const [error, setError] = useState("");
  const [financialEvidenceHashes, setFinancialEvidenceHashes] = useState<
    Record<string, string>
  >({});
  const canVerify = roles.includes("VERIFICATION_OFFICER");
  const canApprove = roles.some((role) =>
    ["CFO", "FINANCE_OFFICER"].includes(role),
  );
  if (batches === null)
    return <p aria-busy="true">Loading migration batches</p>;
  return (
    <section className="panel" aria-labelledby="migration-title">
      <h2 id="migration-title">Legacy migration quarantine</h2>
      {batches.length === 0 ? (
        <p>No migration batches have been uploaded.</p>
      ) : (
        <ul>
          {batches.map((batch, index) => {
            const id =
              stringValue(batch.id) ??
              stringValue(batch.batchId) ??
              String(index);
            const status = stringValue(batch.status) ?? "UNKNOWN";
            return (
              <li key={id}>
                <strong>{stringValue(batch.sourceBatchId) ?? id}</strong> —{" "}
                {status}
                <p>
                  Rows {stringValue(batch.expectedRecords) ?? "0"}; control
                  total {stringValue(batch.expectedTotalMinorUnits) ?? "0"} /
                  reconciled{" "}
                  {stringValue(batch.reconciledTotalMinorUnits) ?? "0"}; sample{" "}
                  {stringValue(batch.samplePassed) ?? "0"}/
                  {stringValue(batch.sampleRequired) ?? "0"}; verifier{" "}
                  {stringValue(batch.verifiedBy) ?? "—"}; approver{" "}
                  {stringValue(batch.approvedBy) ?? "—"}; activated{" "}
                  {stringValue(batch.activatedAt) ?? "—"}
                </p>
                {canVerify && status === "VALIDATED" ? (
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .verify(id)
                        .catch(() => setError("The batch verification failed."))
                    }
                  >
                    Verify sample
                  </button>
                ) : null}
                {canApprove &&
                status === "VALIDATED" &&
                stringValue(batch.verifiedBy) !== null ? (
                  <>
                    <label>
                      Financial evidence hash
                      <input
                        aria-label={`Financial evidence hash for ${id}`}
                        inputMode="text"
                        pattern="[0-9a-f]{64}"
                        value={financialEvidenceHashes[id] ?? ""}
                        onChange={(event) =>
                          setFinancialEvidenceHashes((current) => ({
                            ...current,
                            [id]: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      disabled={
                        !/^[0-9a-f]{64}$/.test(
                          financialEvidenceHashes[id] ?? "",
                        )
                      }
                      onClick={() =>
                        void api
                          .approve(id, financialEvidenceHashes[id]!)
                          .catch(() =>
                            setError("The batch finance approval failed."),
                          )
                      }
                    >
                      Approve reconciled batch
                    </button>
                  </>
                ) : null}
                {canApprove && status === "APPROVED" ? (
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .activateMigration(id)
                        .catch(() => setError("The batch activation failed."))
                    }
                  >
                    Activate reconciled batch
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : null;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
