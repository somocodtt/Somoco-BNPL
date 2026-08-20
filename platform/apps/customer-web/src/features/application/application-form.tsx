import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from "react";
import type {
  ApplicantMutation,
  CustomerApi,
  OnboardingState,
} from "../../lib/api.js";
import { DocumentProgress } from "../documents/document-progress.js";
import { GuarantorStatus } from "../guarantor/guarantor-status.js";
import { IdentityVerification } from "../auth/identity-verification.js";

export function ApplicationForm({
  api,
  state,
  onSave,
  onSubmit,
  onInvite,
  phoneE164,
  onEvidenceChanged,
}: {
  api: CustomerApi;
  state: OnboardingState;
  onSave(input: ApplicantMutation): Promise<"saved" | "queued" | "conflict">;
  onSubmit(): Promise<void>;
  onInvite(guarantorPhoneE164: string): Promise<{
    applicationVersion: number;
    relationshipVersion: number;
    expiresAt: string;
  }>;
  phoneE164: string | null;
  onEvidenceChanged(): Promise<void>;
}) {
  const draft = state.draft!;
  const [vehicleModelId, setVehicleModelId] = useState(
    draft.vehicleModelId ?? "",
  );
  const [occupation, setOccupation] = useState(
    String(draft.applicantProfile.occupation ?? ""),
  );
  const [residentialArea, setResidentialArea] = useState(
    String(draft.applicantProfile.residentialArea ?? ""),
  );
  const [guarantorPhone, setGuarantorPhone] = useState("");
  const guarantorStatus = state.guarantorInvitation.status;
  const [saveState, setSaveState] = useState<"idle" | "saving">("idle");
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const errorSummary = useRef<HTMLElement>(null);

  useEffect(() => {
    setVehicleModelId(draft.vehicleModelId ?? "");
    setOccupation(String(draft.applicantProfile.occupation ?? ""));
    setResidentialArea(String(draft.applicantProfile.residentialArea ?? ""));
  }, [
    draft.applicantProfile.occupation,
    draft.applicantProfile.residentialArea,
    draft.vehicleModelId,
    draft.version,
  ]);

  useEffect(() => {
    if (Object.keys(errors).length > 0) errorSummary.current?.focus();
  }, [errors]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaveState("saving");
    setNotice("");
    setErrors({});
    try {
      const outcome = await onSave({
        expectedVersion: draft.version,
        mutationId: crypto.randomUUID(),
        vehicleModelId,
        profile: { occupation, residentialArea },
      });
      if (outcome === "saved") setNotice("Draft saved");
    } catch (error) {
      if (isFieldProblem(error)) setErrors(error.fieldErrors);
      else setNotice("Draft could not be saved. Try again.");
    } finally {
      setSaveState("idle");
    }
  }

  async function invite() {
    try {
      const result = await onInvite(guarantorPhone);
      setNotice(
        `Invitation sent. It expires ${new Date(result.expiresAt).toLocaleString()}.`,
      );
    } catch (error) {
      setNotice(
        problemCode(error) === "VERSION_CONFLICT"
          ? "Draft changed elsewhere. We refreshed it; review and save again."
          : "Invitation could not be sent. Try again.",
      );
    }
  }

  async function submit() {
    setSaveState("saving");
    setNotice("");
    try {
      await onSubmit();
      setNotice("Your application is in verification review.");
    } catch {
      setNotice(
        "Submission could not be completed. Review the application and try again.",
      );
    } finally {
      setSaveState("idle");
    }
  }

  function focusField(event: MouseEvent<HTMLAnchorElement>, field: string) {
    event.preventDefault();
    document.getElementById(field)?.focus();
  }

  return (
    <main className="shell onboarding-shell">
      <header className="page-header">
        <p className="service-name">Somoco vehicle finance</p>
        <h1>Continue your application</h1>
        <p>Your draft saves securely. Review each section before submission.</p>
      </header>

      {Object.keys(errors).length > 0 ? (
        <section
          ref={errorSummary}
          role="alert"
          tabIndex={-1}
          className="error-summary"
        >
          <h2>There is a problem</h2>
          <ul>
            {Object.entries(errors).map(([field, message]) => (
              <li key={field}>
                <a
                  href={`#${field}`}
                  onClick={(event) => focusField(event, field)}
                >
                  {message}
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}

      <ol className="section-list">
        <li>
          <form onSubmit={(event) => void save(event)} noValidate>
            <section aria-labelledby="vehicle-heading">
              <h2 id="vehicle-heading">Choose a vehicle</h2>
              <label htmlFor="vehicleModelId">Vehicle model</label>
              <select
                id="vehicleModelId"
                value={vehicleModelId}
                onChange={(event) => setVehicleModelId(event.target.value)}
                required
              >
                <option value="">Select a model</option>
                {state.models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.manufacturer} {model.modelName} ({model.modelYear})
                  </option>
                ))}
              </select>
              {state.models.length === 0 ? (
                <p>No vehicle models are currently available.</p>
              ) : null}
            </section>
            <section aria-labelledby="details-heading">
              <h2 id="details-heading">Your details</h2>
              <label htmlFor="occupation">Occupation</label>
              <input
                id="occupation"
                value={occupation}
                onChange={(event) => setOccupation(event.target.value)}
                aria-invalid={errors.occupation ? "true" : undefined}
                required
              />
              {errors.occupation ? (
                <p className="field-error">{errors.occupation}</p>
              ) : null}
              <label htmlFor="residentialArea">Residential area</label>
              <input
                id="residentialArea"
                value={residentialArea}
                onChange={(event) => setResidentialArea(event.target.value)}
                required
              />
            </section>
            <IdentityVerification
              api={api}
              phoneE164={phoneE164}
              idPrefix="applicant"
              onVerified={onEvidenceChanged}
            />
            <DocumentProgress
              {...state.completeness.documentProgress.applicant}
              api={api}
              idPrefix="applicant"
              onAccepted={onEvidenceChanged}
            />
            <button disabled={saveState === "saving" || !vehicleModelId}>
              {saveState === "saving" ? "Saving draft" : "Save and continue"}
            </button>
          </form>
        </li>
        <li>
          <GuarantorStatus status={guarantorStatus} />
          {guarantorStatus === "NOT_INVITED" ||
          guarantorStatus === "EXPIRED" ? (
            <div className="form-group">
              <label htmlFor="guarantorPhone">Guarantor mobile number</label>
              <input
                id="guarantorPhone"
                type="tel"
                value={guarantorPhone}
                onChange={(event) => setGuarantorPhone(event.target.value)}
              />
              <button
                type="button"
                disabled={!/^\+233[1-9]\d{8}$/.test(guarantorPhone)}
                onClick={() => void invite()}
              >
                {guarantorStatus === "EXPIRED"
                  ? "Send new invitation"
                  : "Send invitation"}
              </button>
            </div>
          ) : null}
        </li>
      </ol>
      <section aria-labelledby="status-heading">
        <h2 id="status-heading">Application status</h2>
        <ol aria-label="Application status" className="timeline">
          <li aria-current={draft.status === "DRAFT" ? "step" : undefined}>
            Draft
          </li>
          <li
            aria-current={
              draft.status === "READY_TO_SUBMIT" ? "step" : undefined
            }
          >
            Ready to submit
          </li>
          <li
            aria-current={
              draft.status === "VERIFICATION_REVIEW" ? "step" : undefined
            }
          >
            Verification review
          </li>
        </ol>
        {state.completeness.ready && draft.status === "READY_TO_SUBMIT" ? (
          <button
            type="button"
            disabled={saveState === "saving"}
            onClick={() => void submit()}
          >
            {saveState === "saving"
              ? "Submitting application"
              : "Submit application"}
          </button>
        ) : null}
      </section>
    </main>
  );
}

function isFieldProblem(
  error: unknown,
): error is { fieldErrors: Record<string, string> } {
  return typeof error === "object" && error !== null && "fieldErrors" in error;
}

function problemCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}
