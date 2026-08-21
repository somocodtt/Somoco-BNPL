import { useEffect, useRef, useState } from "react";
import { AuthFlow } from "../features/auth/auth-flow.js";
import { ApplicationForm } from "../features/application/application-form.js";
import { GuarantorForm } from "../features/guarantor/guarantor-form.js";
import { OfferPanel, type OfferApi } from "../features/offer/offer-panel.js";
import {
  ContractPanel,
  type ContractApi,
} from "../features/contract/contract-panel.js";
import { PaymentPanel } from "../features/payments/payment-panel.js";
import type {
  ApplicantMutation,
  CustomerApi,
  CustomerSession,
  OnboardingState,
} from "../lib/api.js";
import type { CustomerPaymentsApi } from "../lib/api.js";
import { SafeMutationQueue } from "../lib/offline-queue.js";

export function CustomerRouter({
  api,
  initialSession = null,
  initialPhoneE164 = null,
  offerApi,
  contractApi,
  paymentsApi,
}: {
  api: CustomerApi;
  initialSession?: CustomerSession | null;
  initialPhoneE164?: string | null;
  offerApi?: OfferApi;
  contractApi?: ContractApi;
  paymentsApi?: CustomerPaymentsApi;
}) {
  const [session, setSession] = useState(initialSession);
  const [phoneE164, setPhoneE164] = useState(initialPhoneE164);
  const [invitationToken] = useState(() => readInvitationToken());
  const [state, setState] = useState<OnboardingState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [offlineNotice, setOfflineNotice] = useState("");
  const [sessionWarning, setSessionWarning] = useState(false);
  const [sessionMessage, setSessionMessage] = useState("");
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
    setSessionWarning(false);
    if (session === null) return;
    const expiresAt = new Date(session.expiresAt).getTime();
    const remaining = expiresAt - Date.now();
    const warnAfter = remaining - 5 * 60_000;
    function expire() {
      setSessionMessage("Your secure session expired. Sign in again.");
      setSession(null);
      setPhoneE164(null);
      setState(null);
    }
    if (!Number.isFinite(expiresAt) || remaining <= 0) {
      expire();
      return;
    }
    let warningTimer: number | undefined;
    if (warnAfter <= 0) setSessionWarning(true);
    else
      warningTimer = window.setTimeout(
        () => setSessionWarning(true),
        warnAfter,
      );
    const expiryTimer = window.setTimeout(expire, remaining);
    return () => {
      if (warningTimer !== undefined) window.clearTimeout(warningTimer);
      window.clearTimeout(expiryTimer);
    };
  }, [session]);

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
    return (
      <>
        {sessionMessage ? <p role="alert">{sessionMessage}</p> : null}
        <AuthFlow
          api={api}
          onAuthenticated={(authenticatedSession, authenticatedPhone) => {
            setSessionMessage("");
            setSession(authenticatedSession);
            setPhoneE164(authenticatedPhone);
          }}
        />
      </>
    );
  if (invitationToken !== null) {
    return (
      <GuarantorForm
        api={api}
        invitationToken={invitationToken}
        phoneE164={phoneE164}
      />
    );
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

  const contractVisibleStatuses = new Set([
    "APPROVED",
    "AWAITING_ASSET_ASSIGNMENT",
    "AWAITING_EXECUTION",
    "EXECUTED",
    "ACTIVE",
    "SETTLED",
    "RECOVERY",
    "TERMINATED",
  ]);
  if (
    loadedState.draft !== null &&
    contractVisibleStatuses.has(loadedState.draft.status) &&
    (offerApi !== undefined || contractApi !== undefined)
  ) {
    return (
      <>
        {sessionWarning ? (
          <p role="alert" className="session-warning">
            Your secure session expires soon. Save your draft now.
          </p>
        ) : null}
        {offerApi !== undefined ? (
          <OfferPanel api={offerApi} applicationId={loadedState.draft!.id} />
        ) : null}
        {contractApi !== undefined ? (
          <ContractPanel
            api={contractApi}
            applicationId={loadedState.draft!.id}
          />
        ) : null}
        {paymentsApi !== undefined ? <PaymentPanel api={paymentsApi} /> : null}
      </>
    );
  }

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
      if (problemCode(error) === "VERSION_CONFLICT") {
        const refreshed = await api.loadOnboarding();
        setState(refreshed);
        setOfflineNotice(
          "Draft changed elsewhere. We refreshed it; review and save again.",
        );
        return "conflict" as const;
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

  async function inviteGuarantor(guarantorPhoneE164: string) {
    try {
      const invitation = await api.inviteGuarantor(loadedState.draft!.id, {
        expectedVersion: loadedState.draft!.version,
        mutationId: crypto.randomUUID(),
        guarantorPhoneE164,
      });
      setState((current) =>
        current === null || current.draft === null
          ? current
          : {
              ...current,
              draft: {
                ...current.draft,
                status: "AWAITING_GUARANTOR",
                version: invitation.applicationVersion,
              },
              guarantorStatus: "INVITED",
              guarantorInvitation: {
                status: "INVITED",
                relationshipVersion: invitation.relationshipVersion,
                expiresAt: invitation.expiresAt,
              },
            },
      );
      return invitation;
    } catch (error) {
      if (problemCode(error) === "VERSION_CONFLICT") {
        setState(await api.loadOnboarding());
      }
      throw error;
    }
  }

  async function refreshEvidence() {
    setState(await api.loadOnboarding());
  }

  return (
    <>
      {sessionWarning ? (
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
        onInvite={inviteGuarantor}
        phoneE164={phoneE164}
        onEvidenceChanged={refreshEvidence}
      />
    </>
  );
}

function problemCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}

function readInvitationToken(): string | null {
  const token = new URLSearchParams(window.location.hash.slice(1)).get(
    "invitation",
  );
  if (token === null || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  window.history.replaceState(
    {},
    "",
    `${window.location.pathname}${window.location.search}`,
  );
  return token;
}
