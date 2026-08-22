import { useEffect, useState } from "react";
import { StaffLogin } from "../features/auth/session.js";
import { canReview } from "../features/access/role-access.js";
import { ReviewPanel } from "../features/application-review/review-panel.js";
import { QueueList, queueTitle } from "../features/queues/queue-list.js";
import {
  ProductWorkspace,
  type ProductApi,
} from "../features/products/product-workspace.js";
import { AssetWorkspace } from "../features/assets/asset-workspace.js";
import { PaymentWorkspace } from "../features/payments/payment-workspace.js";
import {
  CollectionsWorkspace,
  type StaffCollectionsApi,
} from "../features/collections/collections-workspace.js";
import type {
  ApplicationDetail,
  QueueApplication,
  StaffApi,
  StaffAssetApi,
  StaffContractApi,
  StaffPaymentsApi,
  StaffSession,
} from "../lib/api.js";

export function StaffRouter({
  api,
  initialSession = null,
  productsApi,
  assetsApi,
  contractsApi,
  paymentsApi,
  collectionsApi,
}: {
  api: StaffApi;
  initialSession?: StaffSession | null;
  productsApi?: ProductApi;
  assetsApi?: StaffAssetApi;
  contractsApi?: StaffContractApi;
  paymentsApi?: StaffPaymentsApi;
  collectionsApi?: StaffCollectionsApi;
}) {
  const [session, setSession] = useState<StaffSession | null>(initialSession);
  const [queue, setQueue] = useState<QueueApplication[] | null>(null);
  const [detail, setDetail] = useState<ApplicationDetail | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    if (
      session === null ||
      (collectionsApi !== undefined &&
        canOperateCollectionsRole(session.roles)) ||
      (assetsApi !== undefined && session.roles.includes("INVENTORY_OFFICER"))
    ) {
      return;
    }
    let active = true;
    setQueue(null);
    setLoadError("");
    void api.getQueue().then(
      (loaded) => {
        if (active) setQueue(loaded);
      },
      () => {
        if (active) setLoadError("We could not load the actionable queue.");
      },
    );
    return () => {
      active = false;
    };
  }, [api, assetsApi, session]);

  if (session === null) {
    return <StaffLogin api={api} onAuthenticated={setSession} />;
  }
  const canOperateFinancing = session.roles.some((role) =>
    ["PRODUCT_ADMIN", "BSM", "AGM", "CFO", "MD", "COMPLIANCE_AUDITOR"].includes(
      role,
    ),
  );
  const canOperatePayments = session.roles.some((role) =>
    ["FINANCE_OFFICER", "CFO", "COMPLIANCE_AUDITOR", "MD"].includes(role),
  );
  const canOperateCollections = canOperateCollectionsRole(session.roles);
  if (collectionsApi !== undefined && canOperateCollections) {
    return (
      <CollectionsWorkspace
        api={collectionsApi}
        actorId={session.staffUserId}
      />
    );
  }
  if (paymentsApi !== undefined && canOperatePayments) {
    return (
      <PaymentWorkspace
        api={paymentsApi}
        actorId={session.staffUserId}
        roles={session.roles}
      />
    );
  }
  if (productsApi !== undefined && canOperateFinancing) {
    return (
      <ProductWorkspace
        api={productsApi}
        actorId={session.staffUserId}
        roles={session.roles}
      />
    );
  }
  if (assetsApi !== undefined && session.roles.includes("INVENTORY_OFFICER")) {
    return (
      <AssetWorkspace
        api={assetsApi}
        {...(contractsApi === undefined ? {} : { contractsApi })}
      />
    );
  }
  if (!canReview(session.roles)) {
    return (
      <main className="staff-shell">
        <section className="panel" aria-labelledby="access-title">
          <h1 id="access-title">Read-only staff access</h1>
          <p>Your role does not have an actionable approval queue.</p>
        </section>
      </main>
    );
  }
  if (detail !== null) {
    return (
      <main className="staff-shell">
        {notice ? <p role="status">{notice}</p> : null}
        <ReviewPanel
          api={api}
          detail={detail}
          onBack={() => {
            setDetail(null);
            setNotice("");
          }}
          onDecisionSaved={(result) => {
            setDetail((current) =>
              current === null
                ? current
                : {
                    ...current,
                    status: result.status,
                    version: result.version,
                  },
            );
            setQueue(
              (current) =>
                current?.filter((item) => item.id !== detail.id) ?? current,
            );
            setNotice(
              result.action === "REQUEST_INFORMATION"
                ? "Information requested"
                : result.action === "REJECT"
                  ? "Application rejected"
                  : "Decision saved",
            );
          }}
        />
      </main>
    );
  }
  return (
    <main className="staff-shell">
      <section className="panel" aria-labelledby="queue-title">
        <h1 id="queue-title">{queueTitle(session.roles)}</h1>
        {loadError ? <p role="alert">{loadError}</p> : null}
        {queue === null && !loadError ? (
          <p aria-busy="true">Loading actionable queue</p>
        ) : queue !== null ? (
          <QueueList
            items={queue}
            onOpen={(applicationId) => {
              setNotice("");
              void api
                .getApplication(applicationId)
                .then(setDetail, () =>
                  setLoadError("We could not load this application review."),
                );
            }}
          />
        ) : null}
      </section>
    </main>
  );
}

function canOperateCollectionsRole(roles: readonly string[]): boolean {
  return roles.some((role) =>
    [
      "RECOVERY_OFFICER",
      "BSM",
      "AGM",
      "CFO",
      "MD",
      "COMPLIANCE_AUDITOR",
    ].includes(role),
  );
}
