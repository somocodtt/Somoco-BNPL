import { useEffect, useState } from "react";

export interface CustomerOffer {
  id: string;
  status: "PENDING" | "EXPIRED" | "ACCEPTED" | "CANCELLED";
  expiresAt: string;
  priceMinor: string;
  depositMinor: string;
  frequency: "WEEKLY" | "MONTHLY";
  tenureMonths: 6 | 8 | 12 | 24 | 36 | 48;
  totalPayableMinor: string;
  financeChargeMinor: string;
  installments: readonly {
    sequence: number;
    dueDate: string;
    totalMinor: string;
  }[];
  disclosureVersion: string | null;
}

export interface OfferApi {
  get(applicationId: string): Promise<CustomerOffer | null>;
  accept(
    offerId: string,
    input: { consent: boolean; consentAt: string },
  ): Promise<CustomerOffer>;
}

export function OfferPanel({
  api,
  applicationId,
}: {
  api: OfferApi;
  applicationId: string;
}) {
  const [offer, setOffer] = useState<CustomerOffer | null | undefined>(undefined);
  const [loadError, setLoadError] = useState(false);
  const [consent, setConsent] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState("");
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    let active = true;
    setOffer(undefined);
    setLoadError(false);
    void api.get(applicationId).then(
      (result) => {
        if (active) setOffer(result);
      },
      () => {
        if (active) {
          setOffer(null);
          setLoadError(true);
        }
      },
    );
    return () => {
      active = false;
    };
  }, [api, applicationId]);

  if (offer === undefined) {
    return <p aria-busy="true">Loading financing offer</p>;
  }
  if (loadError) {
    return <p role="alert">We could not load your financing offer. Try again.</p>;
  }
  if (offer === null) {
    return <p role="status">No licensed financing offer is available.</p>;
  }
  if (offer.status === "EXPIRED" || new Date(offer.expiresAt).getTime() <= Date.now()) {
    return (
      <section className="panel" aria-labelledby="offer-expired-title">
        <h1 id="offer-expired-title">Financing offer</h1>
        <p role="alert">This offer has expired.</p>
      </section>
    );
  }
  if (offer.status === "CANCELLED") {
    return <p role="status">This financing offer is no longer available.</p>;
  }
  return (
    <section className="panel offer-panel" aria-labelledby="offer-title">
      <h1 id="offer-title">Your financing offer</h1>
      {accepted || offer.status === "ACCEPTED" ? (
        <p role="status">Offer accepted</p>
      ) : null}
      <dl>
        <div>
          <dt>Vehicle price</dt>
          <dd>{formatGhs(offer.priceMinor)}</dd>
        </div>
        <div>
          <dt>Deposit</dt>
          <dd>{formatGhs(offer.depositMinor)}</dd>
        </div>
        <div>
          <dt>Repayment plan</dt>
          <dd>
            {offer.tenureMonths} {offer.frequency === "MONTHLY" ? "monthly" : "weekly"} installments
          </dd>
        </div>
        <div>
          <dt>Finance charge</dt>
          <dd>{formatGhs(offer.financeChargeMinor)}</dd>
        </div>
        <div>
          <dt>Total cost</dt>
          <dd>{formatGhs(offer.totalPayableMinor)} total cost</dd>
        </div>
        <div>
          <dt>Offer expires</dt>
          <dd>{new Date(offer.expiresAt).toLocaleString()}</dd>
        </div>
      </dl>
      <h2>Installment schedule</h2>
      <ol>
        {offer.installments.map((installment) => (
          <li key={installment.sequence}>
            <span>Installment {installment.sequence}</span>
            <time dateTime={installment.dueDate}>{installment.dueDate}</time>
            <strong>{formatGhs(installment.totalMinor)}</strong>
          </li>
        ))}
      </ol>
      <p>Disclosure version: {offer.disclosureVersion ?? "Not supplied"}</p>
      {!accepted && offer.status !== "ACCEPTED" ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!consent) return;
            setAccepting(true);
            setAcceptError("");
            void api
              .accept(offer.id, { consent: true, consentAt: new Date().toISOString() })
              .then((result) => {
                setOffer(result);
                setAccepted(true);
              })
              .catch((error: unknown) => {
                const code =
                  typeof error === "object" && error !== null && "code" in error
                    ? String((error as { code: unknown }).code)
                    : "";
                setAcceptError(
                  code === "OFFER_STALE_OR_EXPIRED"
                    ? "This offer changed or expired. Refresh before accepting."
                    : "The offer could not be accepted. Try again.",
                );
              })
              .finally(() => setAccepting(false));
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={consent}
              onChange={(event) => setConsent(event.target.checked)}
            />
            I have read and agree to the financing disclosures above.
          </label>
          {acceptError ? <p role="alert">{acceptError}</p> : null}
          <button type="submit" disabled={!consent || accepting}>
            {accepting ? "Accepting offer" : "Accept financing offer"}
          </button>
        </form>
      ) : null}
    </section>
  );
}

function formatGhs(minor: string): string {
  if (!/^\d+$/.test(minor)) return "GHS —";
  const major = minor.slice(0, -2) || "0";
  const cents = minor.slice(-2).padStart(2, "0");
  return `GHS ${major.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
}

