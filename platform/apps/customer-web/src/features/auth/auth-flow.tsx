import { useState, type FormEvent } from "react";
import type { CustomerApi, CustomerSession } from "../../lib/api.js";

export function AuthFlow({
  api,
  onAuthenticated,
}: {
  api: CustomerApi;
  onAuthenticated(session: CustomerSession): void;
}) {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function request(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.requestOtp(phone);
      setRequested(true);
    } catch {
      setError("We could not send a code. Check the number and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      onAuthenticated(await api.verifyOtp(phone, code));
    } catch {
      setError("The code is invalid or has expired.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell auth-shell">
      <header>
        <p className="service-name">Somoco vehicle finance</p>
        <h1>Sign in securely</h1>
        <p>Use the mobile number linked to your application.</p>
      </header>
      {error ? (
        <p role="alert" className="inline-error">
          {error}
        </p>
      ) : null}
      {!requested ? (
        <form onSubmit={request}>
          <label htmlFor="phone">Mobile number</label>
          <span id="phone-hint" className="hint">
            Ghana format, for example +233241234567
          </span>
          <input
            id="phone"
            name="phone"
            type="tel"
            autoComplete="tel"
            aria-describedby="phone-hint"
            value={phone}
            onChange={(event) => setPhone(event.target.value)}
            required
          />
          <button disabled={busy}>{busy ? "Sending code" : "Send code"}</button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <label htmlFor="code">Verification code</label>
          <input
            id="code"
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <button disabled={busy}>{busy ? "Checking code" : "Continue"}</button>
        </form>
      )}
    </main>
  );
}
