import { useState, type FormEvent } from "react";
import type { CustomerApi } from "../../lib/api.js";

export function GuarantorForm({
  api,
  invitationToken,
}: {
  api: CustomerApi;
  invitationToken: string;
}) {
  const [occupation, setOccupation] = useState("");
  const [relationship, setRelationship] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      await api.saveGuarantor(invitationToken, {
        expectedVersion: 1,
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
        <button disabled={saving || !occupation || !relationship}>
          {saving ? "Saving guarantor details" : "Save guarantor details"}
        </button>
      </form>
    </main>
  );
}
