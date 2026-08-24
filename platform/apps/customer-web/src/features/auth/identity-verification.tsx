import { useState } from "react";
import type { CustomerApi } from "../../lib/api.js";

export function IdentityVerification({
  api,
  phoneE164,
  idPrefix,
  onVerified,
}: {
  api: CustomerApi;
  phoneE164: string | null;
  idPrefix: string;
  onVerified?(): Promise<void> | void;
}) {
  const [consented, setConsented] = useState(false);
  const [ghanaCardNumber, setGhanaCardNumber] = useState("");
  const [status, setStatus] = useState<"idle" | "verifying" | "verified">(
    "idle",
  );
  const [error, setError] = useState("");
  const cardId = `${idPrefix}-ghana-card`;

  async function verify() {
    if (phoneE164 === null) return;
    setStatus("verifying");
    setError("");
    try {
      const consent = await api.recordConsent({
        purpose: "NIA_IDENTITY_VERIFICATION",
        documentVersion: "nia-consent-v1",
        phoneE164,
      });
      const result = await api.verifyGhanaCard({
        consentId: consent.consentId,
        ghanaCardNumber,
        idempotencyKey: crypto.randomUUID(),
      });
      if (result.status !== "VERIFIED") {
        setStatus("idle");
        setError("Identity verification needs further review.");
        return;
      }
      setGhanaCardNumber("");
      setStatus("verified");
      await onVerified?.();
    } catch {
      setStatus("idle");
      setError("Identity verification could not be completed.");
    }
  }

  return (
    <section aria-labelledby={`${idPrefix}-identity-heading`}>
      <h2 id={`${idPrefix}-identity-heading`}>Identity verification</h2>
      <label>
        <input
          type="checkbox"
          checked={consented}
          onChange={(event) => setConsented(event.target.checked)}
        />
        I agree to identity verification
      </label>
      <label htmlFor={cardId}>Ghana Card number</label>
      <input
        id={cardId}
        value={ghanaCardNumber}
        onChange={(event) => setGhanaCardNumber(event.target.value)}
        autoComplete="off"
        placeholder="GHA-000000000-0"
      />
      <button
        type="button"
        disabled={
          status === "verifying" ||
          !consented ||
          phoneE164 === null ||
          !/^GHA-[0-9]{9}-[0-9]$/.test(ghanaCardNumber)
        }
        onClick={() => void verify()}
      >
        {status === "verifying" ? "Verifying identity" : "Verify identity"}
      </button>
      {status === "verified" ? <p role="status">Identity verified</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
