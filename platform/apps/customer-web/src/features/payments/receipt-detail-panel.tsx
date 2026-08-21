import { useEffect, useState } from "react";
import type {
  CustomerPaymentsApi,
  CustomerReceiptDetail,
} from "../../lib/api.js";

export function ReceiptDetailPanel({
  api,
  receiptId,
}: {
  api: CustomerPaymentsApi;
  receiptId: string;
}) {
  const [receipt, setReceipt] = useState<CustomerReceiptDetail | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    setReceipt(null);
    setError(false);
    void api.getReceipt(receiptId).then(
      (loaded) => {
        if (active) setReceipt(loaded);
      },
      () => {
        if (active) setError(true);
      },
    );
    return () => {
      active = false;
    };
  }, [api, receiptId]);

  if (error) return <p role="alert">We could not load this receipt.</p>;
  if (receipt === null) return <p aria-busy="true">Loading receipt</p>;
  return (
    <main className="shell receipt-detail-panel">
      <h1>Payment receipt</h1>
      <p>Receipt number: {receipt.receiptNumber}</p>
      <p>Payment status: {receipt.status}</p>
      <p>Amount: {formatGhs(receipt.amountMinorUnits)}</p>
      <p>Provider transaction: {receipt.providerTransactionId}</p>
      <p>Issued: {receipt.issuedAt}</p>
    </main>
  );
}

function formatGhs(minor: string): string {
  if (!/^\d+$/.test(minor)) return "GHS —";
  const major = minor.slice(0, -2) || "0";
  const cents = minor.slice(-2).padStart(2, "0");
  return `GHS ${major}.${cents}`;
}
