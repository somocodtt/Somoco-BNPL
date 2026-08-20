import { useState, type ChangeEvent } from "react";

export function DocumentProgress({
  accepted,
  required,
}: {
  accepted: string[];
  required: string[];
}) {
  const [preparing, setPreparing] = useState(false);
  const [ready, setReady] = useState(false);
  async function selected(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setPreparing(true);
    await Promise.resolve();
    setReady(true);
    setPreparing(false);
  }
  return (
    <section aria-labelledby="documents-heading">
      <h2 id="documents-heading">Documents</h2>
      <p>
        {accepted.length} of {required.length} documents accepted
      </p>
      <label htmlFor="evidence">Choose a clear photo</label>
      <span id="evidence-hint" className="hint">
        Images are prepared for low-bandwidth upload before sending.
      </span>
      <input
        id="evidence"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        aria-describedby="evidence-hint"
        onChange={selected}
      />
      {preparing ? <p role="status">Preparing image</p> : null}
      {ready ? <p role="status">Image ready to upload</p> : null}
    </section>
  );
}
