import { useState, type FormEvent } from "react";
import type { StaffApi, StaffSession } from "../../lib/api.js";

export function StaffLogin({
  api,
  onAuthenticated,
}: {
  api: StaffApi;
  onAuthenticated: (session: StaffSession) => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mfaAssertion, setMfaAssertion] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (api.login === undefined) {
      setError("Secure sign-in is unavailable.");
      return;
    }
    setPending(true);
    try {
      onAuthenticated(await api.login({ email, password, mfaAssertion }));
    } catch {
      setError("We could not verify your staff credentials.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="staff-shell">
      <section className="panel" aria-labelledby="staff-login-title">
        <h1 id="staff-login-title">Staff sign in</h1>
        <p>Use your strong credential and MFA assertion to continue.</p>
        <form onSubmit={submit}>
          <label>
            Work email
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
            />
          </label>
          <label>
            Password
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </label>
          <label>
            MFA assertion
            <input
              inputMode="numeric"
              autoComplete="one-time-code"
              value={mfaAssertion}
              onChange={(event) => setMfaAssertion(event.target.value)}
              required
            />
          </label>
          {error ? <p role="alert">{error}</p> : null}
          <button type="submit" disabled={pending}>
            {pending ? "Verifying…" : "Sign in securely"}
          </button>
        </form>
      </section>
    </main>
  );
}
