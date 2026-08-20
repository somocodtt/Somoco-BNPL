export function GuarantorStatus({
  status,
}: {
  status: "NOT_INVITED" | "INVITED" | "EXPIRED" | "CONFIRMED";
}) {
  const copy = {
    NOT_INVITED: "Guarantor not invited",
    INVITED: "Invitation sent. Waiting for the guarantor.",
    EXPIRED: "Invitation expired",
    CONFIRMED: "Guarantor section complete",
  } as const;
  return (
    <section aria-labelledby="guarantor-heading">
      <h2 id="guarantor-heading">Guarantor</h2>
      <p>{copy[status]}</p>
      <p className="hint">
        Your guarantor signs in with their own mobile number. They cannot see
        your details.
      </p>
    </section>
  );
}
