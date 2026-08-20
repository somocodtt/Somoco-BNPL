import { useEffect, useRef, useState } from "react";
import { AuthFlow } from "../features/auth/auth-flow.js";
import { ApplicationForm } from "../features/application/application-form.js";
import { GuarantorForm } from "../features/guarantor/guarantor-form.js";
import type {
  ApplicantMutation,
  CustomerApi,
  CustomerSession,
  OnboardingState,
} from "../lib/api.js";
import { SafeMutationQueue } from "../lib/offline-queue.js";

export function CustomerRouter({
  api,
  initialSession = null,
}: {
  api: CustomerApi;
  initialSession?: CustomerSession | null;
}) {
  const [session, setSession] = useState(initialSession);
  const [invitationToken] = useState(() => readInvitationToken());
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [offlineNotice, setOfflineNotice] = useState("");
  const queue = useRef<SafeMutationQueue | null>(null);
  if (queue.current === null)
    queue.current = new SafeMutationQueue(localStorage);

  useEffect(() => {
    if (session === null || invitationToken !== null) return;
    let active = true;
    api.loadOnboarding().then(
      (loaded) => {
        if (active) setState(loaded);
      },
      () => {
        if (active) setLoadError("We could not load your draft. Try again.");
      },
    );
    return () => {
      active = false;
    };
  }, [api, invitationToken, session]);

  useEffect(() => {
    async function retry() {
      const queued = queue.current?.read()[0];
      if (queued === undefined) return;
      try {
        const saved = await api.saveApplicant(
          queued.applicationId,
          queued.input,
        );
        queue.current?.clear();
        setState((current) =>
          current?.draft === null || current === null
            ? current
            : { ...current, draft: { ...current.draft, ...saved } },
        );
        setOfflineNotice("Offline changes saved");
      } catch {
        setOfflineNotice(
          "Still offline. Your safe draft changes remain queued.",
        );
      }
    }
    window.addEventListener("online", retry);
    return () => window.removeEventListener("online", retry);
  }, [api]);

  if (session === null)
    return <AuthFlow api={api} onAuthenticated={setSession} />;
  if (invitationToken !== null) {
    return <GuarantorForm api={api} invitationToken={invitationToken} />;
  }
  if (loadError)
    return (
      <main className="shell">
        <p role="alert">{loadError}</p>
      </main>
    );
  if (state === null)
    return (
      <main className="shell" aria-busy="true">
        <p>Loading your secure draft</p>
      </main>
    );
  if (state.draft === null)
    return (
      <main className="shell">
        <p>No draft is available.</p>
      </main>
    );
  const loadedState = state;

  const minutesRemaining =
    (new Date(session.expiresAt).getTime() - Date.now()) / 60_000;
  async function save(input: ApplicantMutation) {
    try {
      const saved = await api.saveApplicant(loadedState.draft!.id, input);
      setState((current) =>
        current === null
          ? current
          : { ...current, draft: { ...current.draft!, ...saved } },
      );
      return "saved" as const;
    } catch (error) {
      if (error instanceof TypeError) {
        queue.current?.enqueue(loadedState.draft!.id, input);
        setOfflineNotice(
          "Saved on this device; will retry when you are online",
        );
        return "queued" as const;
      }
      throw error;
    }
  }

  async function submit() {
    const submitted = await api.submit(loadedState.draft!.id, {
      expectedVersion: loadedState.draft!.version,
      mutationId: crypto.randomUUID(),
    });
    setState((current) =>
      current === null
        ? current
        : {
            ...current,
            draft: { ...current.draft!, ...submitted },
            completeness: { ...current.completeness, ready: false },
          },
    );
  }

  return (
    <>
      {minutesRemaining <= 5 ? (
        <p role="alert" className="session-warning">
          Your secure session expires soon. Save your draft now.
        </p>
      ) : null}
      {offlineNotice ? (
        <p role="status" className="offline-notice">
          {offlineNotice}
        </p>
      ) : null}
      <ApplicationForm
        api={api}
        state={loadedState}
        onSave={save}
        onSubmit={submit}
      />
    </>
  );
}

function readInvitationToken(): string | null {
  const token = new URLSearchParams(window.location.search).get("invitation");
  if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${window.location.hash}`,
  );
  return token;
}
