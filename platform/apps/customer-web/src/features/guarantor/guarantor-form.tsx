import { useEffect, useState, type FormEvent } from "react";
import type { CustomerApi } from "../../lib/api.js";
import { IdentityVerification } from "../auth/identity-verification.js";
import { DocumentProgress } from "../documents/document-progress.js";

type Resolution = Awaited<
  ReturnType<CustomerApi["resolveGuarantorInvitation"]>
>;

export function GuarantorForm({
  api,
  invitationToken,
  phoneE164,
}: {
  api: CustomerApi;
  invitationToken: string;
  phoneE164: string | null;
}) {
  const [occupation, setOccupation] = useState("");
  const [relationship, setRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [identityVerified, setIdentityVerified] = useState(false);
  const [documentAccepted, setDocumentAccepted] = useState(false);

  useEffect(() => {
    let active = true;
    api.resolveGuarantorInvitation(invitationToken).then(
      (resolved) => {
        if (active) setResolution(resolved);
      },
      () => {
        if (active) setError("This invitation is invalid or unavailable.");
      },
    );
    return () => {
      active = false;
    };
  }, [api, invitationToken]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.saveGuarantor(invitationToken, {
        expectedVersion: resolution!.relationshipVersion,
        mutationId: crypto.randomUUID(),
        profile: { occupation, relationshipToApplicant: relationship },
      });
      setNotice("Your details were sent securely.");
    } catch {
      setError(
        "We could not save your details. Check the invitation and try again.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (resolution === null) {
    return (
      <main className="shell" aria-busy="true">
        {error ? <p role="alert">{error}</p> : <p>Checking invitation</p>}
      </main>
    );
  }
  if (resolution.status === "EXPIRED") {
    return (
      <main className="shell">
        <h1>Invitation expired</h1>
        <p>Ask the applicant to send a new invitation.</p>
      </main>
    );
  }
  if (resolution.status === "CONFIRMED") {
    return (
      <main className="shell">
        <h1>Guarantor section complete</h1>
        <p>Your details were already sent securely.</p>
      </main>
    );
  }

  return (
    <main className="shell onboarding-shell">
      <header className="page-header">
        <p className="service-name">Somoco vehicle finance</p>
        <h1>Complete your guarantor details</h1>
        <p>
          You have your own secure sign-in. The applicant's details are not
          shown here.
        </p>
      </header>
      {error ? (
        <p role="alert" className="error-summary">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="notice">
          {notice}
        </p>
      ) : null}
      <form onSubmit={(event) => void save(event)}>
        <IdentityVerification
          api={api}
          phoneE164={phoneE164}
          idPrefix="guarantor"
          onVerified={() => setIdentityVerified(true)}
        />
        <DocumentProgress
          api={api}
          idPrefix="guarantor"
          accepted={[]}
          required={["GHANA_CARD_FRONT"]}
          onAccepted={() => setDocumentAccepted(true)}
        />
        <label htmlFor="guarantorOccupation">Occupation</label>
        <input
          id="guarantorOccupation"
          value={occupation}
          onChange={(event) => setOccupation(event.target.value)}
          required
        />
        <label htmlFor="relationshipToApplicant">
          Relationship to applicant
        </label>
        <input
          id="relationshipToApplicant"
          value={relationship}
          onChange={(event) => setRelationship(event.target.value)}
          required
        />
        <button
          disabled={
            saving ||
            !occupation ||
            !relationship ||
            !identityVerified ||
            !documentAccepted
          }
        >
          {saving ? "Saving guarantor details" : "Save guarantor details"}
        </button>
      </form>
    </main>
  );
}
