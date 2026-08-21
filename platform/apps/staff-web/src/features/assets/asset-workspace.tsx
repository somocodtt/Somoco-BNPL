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
  const [applicantSignature, setApplicantSignature] = useState("");
  const [guarantorSignature, setGuarantorSignature] = useState("");
  const [staffWitnessId, setStaffWitnessId] = useState("");
  const [executedDocumentId, setExecutedDocumentId] = useState("");
  const [executedDocumentHash, setExecutedDocumentHash] = useState("");
  const [headOfficeId, setHeadOfficeId] = useState("");
  const [headOfficeLocation, setHeadOfficeLocation] = useState("");
  const [customerAcknowledgementId, setCustomerAcknowledgementId] =
    useState("");
  const [checklist, setChecklist] = useState<Record<string, boolean>>({
    identity_verified: false,
    keys_received: false,
    condition_recorded: false,
    accessories_recorded: false,
  });

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

  async function recordExecution() {
    if (contract === null || contract === undefined) return;
    setActionError("");
    setNotice("");
    try {
      setContract(
        await api.recordExecution(contract.id, {
          expectedVersion: contract.version,
          applicantSignature,
          guarantorSignature,
          staffWitnessId,
          executionDate: new Date().toISOString(),
          headOfficeId,
          headOfficeLocation,
          executedDocumentId,
          executedDocumentHash,
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setNotice("Physical execution evidence recorded");
    } catch (error) {
      setActionError(contractActionMessage(error));
    }
  }

  async function completeHandover() {
    if (contract === null || contract === undefined) return;
    setActionError("");
    setNotice("");
    const items = Object.entries(checklist).map(([itemId, complete]) => ({
      itemId,
      result: complete ? "PASS" : "INCOMPLETE",
    }));
    try {
      setContract(
        await api.completeHandover(contract.id, {
          expectedVersion: contract.version,
          checklistVersion: "handover-v1",
          checklist: { items },
          customerAcknowledged: true,
          customerAcknowledgementId,
          condition: {},
          accessories: [],
          headOfficeId,
          headOfficeLocation,
          handedOverAt: new Date().toISOString(),
          idempotencyKey: crypto.randomUUID(),
        }),
      );
      setNotice("Physical handover recorded");
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
            <form
              aria-label="Physical contract execution"
              onSubmit={(event) => {
                event.preventDefault();
                void recordExecution();
              }}
            >
              <p>
                Physical applicant and guarantor signatures, a staff witness,
                and a clean executed PDF are required at the configured head
                office.
              </p>
              <label>
                Applicant signature
                <input
                  value={applicantSignature}
                  onChange={(event) => setApplicantSignature(event.target.value)}
                />
              </label>
              <label>
                Guarantor signature
                <input
                  value={guarantorSignature}
                  onChange={(event) => setGuarantorSignature(event.target.value)}
                />
              </label>
              <label>
                Staff witness ID
                <input
                  value={staffWitnessId}
                  onChange={(event) => setStaffWitnessId(event.target.value)}
                />
              </label>
              <label>
                Executed PDF document ID
                <input
                  value={executedDocumentId}
                  onChange={(event) => setExecutedDocumentId(event.target.value)}
                />
              </label>
              <label>
                Executed PDF SHA-256
                <input
                  value={executedDocumentHash}
                  onChange={(event) => setExecutedDocumentHash(event.target.value)}
                />
              </label>
              <label>
                Main head-office ID
                <input
                  value={headOfficeId}
                  onChange={(event) => setHeadOfficeId(event.target.value)}
                />
              </label>
              <label>
                Main head-office location
                <input
                  value={headOfficeLocation}
                  onChange={(event) => setHeadOfficeLocation(event.target.value)}
                />
              </label>
              <button type="submit">Record physical execution</button>
            </form>
          ) : null}
          {contract.status === "EXECUTED" ? (
            <form
              aria-label="Physical vehicle handover"
              onSubmit={(event) => {
                event.preventDefault();
                void completeHandover();
              }}
            >
              <p>
                Handover is blocked until the applicant acknowledgement ID,
                explicit checklist results, witness location, and current
                contract version are present.
              </p>
              <label>
                Applicant acknowledgement ID
                <input
                  value={customerAcknowledgementId}
                  onChange={(event) =>
                    setCustomerAcknowledgementId(event.target.value)
                  }
                />
              </label>
              <fieldset>
                <legend>Handover checklist</legend>
                {Object.keys(checklist).map((itemId) => (
                  <label key={itemId}>
                    <input
                      type="checkbox"
                      checked={checklist[itemId]}
                      onChange={(event) =>
                        setChecklist((current) => ({
                          ...current,
                          [itemId]: event.target.checked,
                        }))
                      }
                    />
                    {itemId.replaceAll("_", " ")} — PASS
                  </label>
                ))}
              </fieldset>
              <button type="submit">Record physical handover</button>
            </form>
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
  if (code === "STALE_VERSION")
    return "This control is stale. Refresh the contract before recording execution, handover, or activation.";
  if (code === "CUSTOMER_ACKNOWLEDGEMENT_REQUIRED")
    return "Handover blocked: the applicant must acknowledge the exact checklist in their secure session.";
  if (code === "HEAD_OFFICE_BINDING_INVALID")
    return "Physical control blocked: use the configured main head-office ID and location.";
  if (code === "EXECUTED_DOCUMENT_NOT_CLEAN")
    return "Execution blocked: provide the accepted clean executed-contract PDF evidence.";
  return "The contract control could not be completed.";
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error))
    return "";
  return typeof error.code === "string" ? error.code : "";
}
