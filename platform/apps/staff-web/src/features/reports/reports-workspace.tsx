import { useEffect, useState } from "react";
import type {
  StaffMigrationApi,
  StaffReportName,
  StaffReportsApi,
} from "../../lib/api.js";

export function ReportsWorkspace({
  api,
  migrationApi,
  roles,
  reportName = "operations",
}: {
  api: StaffReportsApi;
  migrationApi?: StaffMigrationApi;
  roles: readonly string[];
  reportName?: StaffReportName;
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
    void api.getReport(reportName).then(
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
  }, [api, migrationApi, reportName]);

  if (error) return <p role="alert">{error}</p>;
  if (report === null)
    return <p aria-busy="true">Loading operational reporting</p>;

  const rows = Array.isArray(report.rows) ? report.rows.filter(isRecord) : [];
  return (
    <main className="staff-shell reports-workspace">
      <section className="panel" aria-labelledby="reports-title">
        <h1 id="reports-title">{reportTitle(reportName)}</h1>
        <p role="status">
          Server-enforced classification:{" "}
          {stringValue(report.dataClassification) ?? "REDACTED"}
        </p>
        <button
          type="button"
          onClick={() => {
            setNotice("");
            void api.exportReport({ report: reportName, format: "CSV" }).then(
              (value) => {
                downloadArtifact(value, reportName);
                setNotice(
                  stringValue(value.status) === "QUEUED"
                    ? `Export ${stringValue(value.id) ?? "created"} is queued for worker delivery.`
                    : stringValue(value.content) === null
                      ? `Export ${stringValue(value.id) ?? "created"} attributed to the requester.`
                      : `Export ${stringValue(value.id) ?? "created"} downloaded and attributed to the requester.`,
                );
              },
              () => setNotice("The export could not be created."),
            );
          }}
        >
          Export {reportName} CSV
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
  const [migrationFile, setMigrationFile] = useState<File | null>(null);
  const [financialEvidenceHashes, setFinancialEvidenceHashes] = useState<
    Record<string, string>
  >({});
  const canVerify = roles.includes("VERIFICATION_OFFICER");
  const canImport = roles.some((role) =>
    ["SYSTEM_ADMIN", "MIGRATION_IMPORTER"].includes(role),
  );
  const canApprove = roles.some((role) =>
    ["CFO", "FINANCE_OFFICER"].includes(role),
  );
  if (batches === null)
    return <p aria-busy="true">Loading migration batches</p>;
  return (
    <section className="panel" aria-labelledby="migration-title">
      <h2 id="migration-title">Legacy migration quarantine</h2>
      {canImport ? (
        <div>
          <label>
            Legacy migration JSON
            <input
              aria-label="Legacy migration JSON"
              type="file"
              accept="application/json,.json"
              onChange={(event) =>
                setMigrationFile(event.target.files?.[0] ?? null)
              }
            />
          </label>
          <button
            type="button"
            disabled={migrationFile === null}
            onClick={() => {
              if (migrationFile === null) return;
              void migrationFile
                .text()
                .then((value) => JSON.parse(value) as Record<string, unknown>)
                .then((value) => api.importBatch(value))
                .then(
                  (value) =>
                    setError(
                      `Imported migration batch ${stringValue(value.id) ?? "created"}.`,
                    ),
                  () => setError("The migration upload could not be imported."),
                );
            }}
          >
            Upload migration batch
          </button>
        </div>
      ) : null}
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
                {canImport && status === "QUARANTINED" ? (
                  <button
                    type="button"
                    onClick={() =>
                      void api
                        .validate(id)
                        .catch(() => setError("The batch validation failed."))
                    }
                  >
                    Validate batch
                  </button>
                ) : null}
                {Array.isArray(batch.records) || Array.isArray(batch.events) ? (
                  <details>
                    <summary>Evidence, row errors, and match history</summary>
                    <pre>
                      {JSON.stringify(
                        {
                          records: batch.records ?? [],
                          events: batch.events ?? [],
                        },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
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

function reportTitle(report: StaffReportName): string {
  switch (report) {
    case "audit":
      return "Audit evidence reporting";
    case "migration":
      return "Legacy migration reporting";
    case "portfolio":
      return "Portfolio reporting";
    default:
      return "Operations and portfolio reporting";
  }
}

function downloadArtifact(
  value: Record<string, unknown>,
  report: StaffReportName,
): void {
  const content = stringValue(value.content);
  const id = stringValue(value.id);
  const format = stringValue(value.format)?.toLowerCase() ?? "csv";
  if (
    content === null ||
    id === null ||
    typeof document === "undefined" ||
    typeof URL === "undefined"
  )
    return;
  const objectUrl = URL.createObjectURL(
    new Blob([content], {
      type: format === "json" ? "application/json" : "text/csv",
    }),
  );
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `somo-${report}-${id}.${format}`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
