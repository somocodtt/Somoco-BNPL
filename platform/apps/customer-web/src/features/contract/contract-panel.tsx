import { useEffect, useState } from "react";

export type CustomerContractStatus =
  | "DRAFT"
  | "AWAITING_EXECUTION"
  | "EXECUTED"
  | "ACTIVE"
  | "SETTLED"
  | "RECOVERY"
  | "TERMINATED";

export interface CustomerContractView {
  status: CustomerContractStatus;
  previewAvailable: boolean;
  executed: boolean;
  assignedVehicleAvailable: boolean;
  registrationNumber: string | null;
  registrationValidTo: string | null;
  insuranceValidTo: string | null;
  schedule: readonly {
    sequence: number;
    dueDate: string;
    totalMinor: string;
  }[];
}

export interface ContractApi {
  getContract(applicationId: string): Promise<CustomerContractView | null>;
}

export function ContractPanel({
  api,
  applicationId,
}: {
  api: ContractApi;
  applicationId: string;
}) {
  const [contract, setContract] = useState<
    CustomerContractView | null | undefined
  >(undefined);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    let active = true;
    setContract(undefined);
    setLoadError(false);
    void api.getContract(applicationId).then(
      (result) => {
        if (active) setContract(result);
      },
      () => {
        if (active) {
          setContract(null);
          setLoadError(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api, applicationId]);

  if (contract === undefined && !loadError) {
    return <p aria-busy="true">Loading contract and handover state</p>;
  }
  if (loadError) {
    return (
      <p role="alert">We could not load your contract state. Try again.</p>
    );
  }
  if (contract === undefined) {
    return <p aria-busy="true">Loading contract and handover state</p>;
  }
  if (contract === null) {
    return <p role="status">No contract preview is available yet.</p>;
  }

  return (
    <section className="panel contract-panel" aria-labelledby="contract-title">
      <h1 id="contract-title">Your contract and vehicle handover</h1>
      <p role="status">Contract status: {contract.status}</p>
      {contract.previewAvailable ? (
        <p>Unsigned contract preview is available for review.</p>
      ) : null}
      {!contract.executed ? (
        <p role="status">
          Physical signatures and a clean executed PDF at head office are still
          required.
        </p>
      ) : (
        <p role="status">Contract execution is recorded.</p>
      )}
      {contract.assignedVehicleAvailable ? (
        <section aria-labelledby="vehicle-summary-title">
          <h2 id="vehicle-summary-title">Assigned vehicle summary</h2>
          <p>
            Vehicle details are shown after handover. Somoco remains the
            ownership holder.
          </p>
          <dl>
            <div>
              <dt>Registration</dt>
              <dd>{contract.registrationNumber ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Registration valid to</dt>
              <dd>{contract.registrationValidTo ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Insurance valid to</dt>
              <dd>{contract.insuranceValidTo ?? "Not recorded"}</dd>
            </div>
          </dl>
        </section>
      ) : (
        <p role="status">
          Assigned vehicle details remain locked until handover is complete.
        </p>
      )}
      {contract.schedule.length > 0 ? (
        <section aria-labelledby="contract-schedule-title">
          <h2 id="contract-schedule-title">Repayment schedule</h2>
          <ol>
            {contract.schedule.map((installment) => (
              <li key={installment.sequence}>
                <span>Installment {installment.sequence}</span>
                <time dateTime={installment.dueDate}>
                  {installment.dueDate}
                </time>
                <strong>{formatGhs(installment.totalMinor)}</strong>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      <p>Location access is restricted to authorized recovery staff.</p>
    </section>
  );
}

function formatGhs(minor: string): string {
  if (!/^\d+$/.test(minor)) return "GHS —";
  const major = minor.slice(0, -2) || "0";
  const cents = minor.slice(-2).padStart(2, "0");
  return `GHS ${major.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}
