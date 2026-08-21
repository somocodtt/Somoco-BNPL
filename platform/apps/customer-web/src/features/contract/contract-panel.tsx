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
  contractId: string;
  status: CustomerContractStatus;
  previewAvailable: boolean;
  executed: boolean;
  assignedVehicleAvailable: boolean;
  registrationNumber: string | null;
  registrationValidTo: string | null;
  insuranceValidTo: string | null;
  handoverAcknowledged: boolean;
  schedule: readonly {
    sequence: number;
    dueDate: string;
    totalMinor: string;
  }[];
}

export interface ContractApi {
  getContract(applicationId: string): Promise<CustomerContractView | null>;
  acknowledgeHandover(
    contractId: string,
    input: {
      checklistVersion: string;
      checklist: Record<string, unknown>;
      idempotencyKey: string;
    },
  ): Promise<{ id: string; acknowledgedAt: string }>;
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
  const [acknowledging, setAcknowledging] = useState(false);
  const [ackError, setAckError] = useState("");

  const checklist = {
    items: [
      { itemId: "identity_verified", result: "PASS" },
      { itemId: "keys_received", result: "PASS" },
      { itemId: "condition_recorded", result: "PASS" },
      { itemId: "accessories_recorded", result: "PASS" },
    ],
  };

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
  const activeContract = contract;

  async function acknowledgeHandover() {
    setAcknowledging(true);
    setAckError("");
    try {
      await api.acknowledgeHandover(activeContract.contractId, {
        checklistVersion: "handover-v1",
        checklist,
        idempotencyKey: crypto.randomUUID(),
      });
      setContract({ ...activeContract, handoverAcknowledged: true });
    } catch {
      setAckError(
        "Your acknowledgement could not be recorded. Confirm the checklist and secure session, then try again.",
      );
    } finally {
      setAcknowledging(false);
    }
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
      {contract.executed && !contract.handoverAcknowledged ? (
        <section aria-labelledby="handover-ack-title">
          <h2 id="handover-ack-title">Customer handover acknowledgement</h2>
          <p>
            Review the physical checklist at Somoco head office. Your secure
            applicant session records this acknowledgement; staff cannot sign
            for you.
          </p>
          <ul aria-label="Handover checklist">
            {checklist.items.map((item) => (
              <li key={item.itemId}>{item.itemId.replaceAll("_", " ")}: PASS</li>
            ))}
          </ul>
          <button
            type="button"
            onClick={() => void acknowledgeHandover()}
            disabled={acknowledging}
          >
            {acknowledging ? "Recording acknowledgement…" : "Acknowledge handover"}
          </button>
          {ackError ? <p role="alert">{ackError}</p> : null}
        </section>
      ) : null}
      {contract.handoverAcknowledged ? (
        <p role="status">Your handover acknowledgement is recorded.</p>
      ) : null}
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
