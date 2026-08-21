import { useEffect, useState } from "react";
import type {
  StaffAssetApi,
  StaffAssetSummary,
  StaffAssignmentSummary,
  StaffContractApi,
  StaffContractSummary,
} from "../../lib/api.js";

export function AssetWorkspace({
  api,
  contractsApi,
}: {
  api: StaffAssetApi;
  contractsApi?: StaffContractApi;
}) {
  const [assets, setAssets] = useState<StaffAssetSummary[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [applicationId, setApplicationId] = useState("");
  const [vehicleUnitId, setVehicleUnitId] = useState("");
  const [expectedVersion, setExpectedVersion] = useState("1");
  const [assignment, setAssignment] = useState<StaffAssignmentSummary | null>(
    null,
  );
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    let active = true;
    setAssets(null);
    setLoadError(false);
    void api.listInventory().then(
      (loaded) => {
        if (active) setAssets(loaded);
      },
      () => {
        if (active) setLoadError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api]);

  if (assets === null && !loadError) {
    return <p aria-busy="true">Loading asset inventory</p>;
  }
  if (loadError) {
    return <p role="alert">We could not load asset inventory. Try again.</p>;
  }
  if (assets === null) return null;

  return (
    <main className="staff-shell asset-workspace">
      <section className="panel" aria-labelledby="assets-title">
        <h1 id="assets-title">Asset inventory and assignment</h1>
        <p role="status">
          Assignment gate: MD approval, accepted locked offer, reconciled
          deposit, matching model, and current registration and insurance are
          required.
        </p>
        {assets.length === 0 ? (
          <p role="status">No vehicles are registered for assignment.</p>
        ) : (
          <ul aria-label="Asset inventory">
            {assets.map((asset) => (
              <li key={asset.id}>
                <strong>{asset.vin}</strong>
                <span>Chassis {asset.chassisNumber}</span>
                <span>
                  Engine/motor {asset.engineMotorIdentifier ?? "not recorded"}
                </span>
                <span>Status: {asset.status}</span>
                <span>
                  Registration: {asset.registrationNumber ?? "not recorded"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setVehicleUnitId(asset.id);
                    setExpectedVersion(String(asset.version));
                    setActionError("");
                  }}
                >
                  Use this vehicle
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel" aria-labelledby="assignment-title">
        <h2 id="assignment-title">Assign selected vehicle</h2>
        <p>
          Do not assign a vehicle until deposit reconciliation and coverage
          evidence are visible.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setNotice("");
            setActionError("");
            const version = Number(expectedVersion);
            if (
              applicationId.trim() === "" ||
              vehicleUnitId.trim() === "" ||
              !Number.isSafeInteger(version) ||
              version < 1
            ) {
              setActionError(
                "Application, vehicle, and a valid expected version are required.",
              );
              return;
            }
            void api
              .assignVehicle(applicationId.trim(), {
                vehicleUnitId: vehicleUnitId.trim(),
                expectedVehicleVersion: version,
                idempotencyKey: crypto.randomUUID(),
              })
              .then((result) => {
                setAssignment(result);
                setNotice("Vehicle assignment recorded");
              })
              .catch((error: unknown) =>
                setActionError(assetActionMessage(error)),
              );
          }}
        >
          <label>
            Application ID
            <input
              value={applicationId}
              onChange={(event) => setApplicationId(event.target.value)}
            />
          </label>
          <label>
            Vehicle ID
            <input
              value={vehicleUnitId}
              onChange={(event) => setVehicleUnitId(event.target.value)}
            />
          </label>
          <label>
            Expected vehicle version
            <input
              type="number"
              min="1"
              value={expectedVersion}
              onChange={(event) => setExpectedVersion(event.target.value)}
            />
          </label>
          <button type="submit">Assign vehicle</button>
        </form>
        {actionError ? <p role="alert">{actionError}</p> : null}
        {notice ? <p role="status">{notice}</p> : null}
        {assignment ? (
          <p role="status">
            Assignment {assignment.id} is version {assignment.version}; deposit
            evidence is recorded.
          </p>
        ) : null}
      </section>

      {contractsApi !== undefined ? (
        <ContractWorkspace api={contractsApi} />
      ) : null}
    </main>
  );
}

export function ContractWorkspace({ api }: { api: StaffContractApi }) {
  const [applicationId, setApplicationId] = useState("");
  const [assignmentId, setAssignmentId] = useState("");
  const [contract, setContract] = useState<
    StaffContractSummary | null | undefined
  >(undefined);
  const [actionError, setActionError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadContract() {
    setContract(undefined);
    setActionError("");
    try {
      setContract(await api.get(applicationId.trim()));
    } catch {
      setActionError("We could not load the contract control state.");
      setContract(null);
    }
  }

  async function generate() {
    setActionError("");
    setNotice("");
    try {
      const generated = await api.generate(applicationId.trim(), {
        assignmentId: assignmentId.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      setContract(generated);
      setNotice("Contract preview generated from locked offer and assignment");
    } catch (error) {
      setActionError(contractActionMessage(error));
    }
  }

  async function activate() {
    if (contract === null || contract === undefined) return;
    setActionError("");
    setNotice("");
    try {
      setContract(
        await api.activate(contract.id, {
          expectedVersion: contract.version,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setNotice("Activation recorded");
    } catch (error) {
      setActionError(contractActionMessage(error));
    }
  }

  return (
    <section className="panel" aria-labelledby="contract-controls-title">
      <h2 id="contract-controls-title">
        Contract, execution, handover, and activation controls
      </h2>
      <p>
        Production generation stays blocked until an externally attested
        approved legal template is supplied. Somoco remains the ownership holder
        through activation.
      </p>
      <label>
        Application ID
        <input
          value={applicationId}
          onChange={(event) => setApplicationId(event.target.value)}
        />
      </label>
      <label>
        Assignment ID for preview generation
        <input
          value={assignmentId}
          onChange={(event) => setAssignmentId(event.target.value)}
        />
      </label>
      <div>
        <button
          type="button"
          onClick={() => void loadContract()}
          disabled={applicationId.trim() === ""}
        >
          Load contract controls
        </button>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={applicationId.trim() === "" || assignmentId.trim() === ""}
        >
          Generate unsigned preview
        </button>
      </div>
      {contract === undefined ? (
        <p aria-busy="true">Enter an application to load contract state.</p>
      ) : null}
      {contract === null ? (
        <p role="status">
          No contract has been generated for this application.
        </p>
      ) : null}
      {contract ? (
        <div aria-label="Contract state">
          <p role="status">Contract status: {contract.status}</p>
          <p>Immutable contract reference: {contract.reference}</p>
          <p>Template-derived preview: {contract.previewReference}</p>
          <p>Ownership holder: {contract.ownershipHolder}</p>
          {contract.status === "AWAITING_EXECUTION" ? (
            <p>
              Physical applicant and guarantor signatures plus a clean executed
              PDF are required at head office.
            </p>
          ) : null}
          {contract.status === "EXECUTED" ? (
            <button type="button" onClick={() => void activate()}>
              Activate after checklist and coverage gates
            </button>
          ) : null}
          {contract.status === "ACTIVE" ? (
            <p role="status">
              Financing is active; repayment schedule is available to the
              customer.
            </p>
          ) : null}
        </div>
      ) : null}
      {actionError ? <p role="alert">{actionError}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
}

function assetActionMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "DEPOSIT_RECONCILIATION_REQUIRED")
    return "Assignment blocked: reconcile the locked deposit first.";
  if (code === "REGISTRATION_INSURANCE_REQUIRED")
    return "Assignment blocked: current registration and insurance are required.";
  if (code === "VEHICLE_MODEL_MISMATCH")
    return "Assignment blocked: vehicle model does not match the application.";
  if (code === "STALE_VERSION")
    return "The vehicle changed before assignment. Refresh inventory and try again.";
  return "The vehicle assignment could not be recorded.";
}

function contractActionMessage(error: unknown): string {
  const code = errorCode(error);
  if (code === "LEGAL_TEMPLATE_APPROVAL_REQUIRED")
    return "Generation blocked: no externally attested approved legal template is available.";
  if (code === "ACCEPTED_LOCKED_OFFER_REQUIRED")
    return "Generation blocked: the accepted locked offer is unavailable or expired.";
  if (code === "HANDOVER_REQUIRED")
    return "Activation blocked: complete the signed handover checklist first.";
  return "The contract control could not be completed.";
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error))
    return "";
  return typeof error.code === "string" ? error.code : "";
}
