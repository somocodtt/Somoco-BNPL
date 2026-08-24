import { useState, type ChangeEvent } from "react";
import type { CustomerApi } from "../../lib/api.js";
import { prepareImageForUpload } from "./image-preparation.js";

export function DocumentProgress({
  accepted,
  required,
  api,
  idPrefix,
  onAccepted,
}: {
  accepted: string[];
  required: string[];
  api: CustomerApi;
  idPrefix: string;
  onAccepted?(): Promise<void> | void;
}) {
  const [locallyAccepted, setLocallyAccepted] = useState(accepted);
  const [progress, setProgress] = useState<Record<string, string>>({});
  async function selected(
    documentType: string,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];
    if (file === undefined) return;
    setProgress((current) => ({ ...current, [documentType]: "Preparing image" }));
    try {
      const prepared = await prepareImageForUpload(file);
      const ticket = await api.requestDocumentUpload({
        documentType,
        mimeType: prepared.type || file.type,
        sizeBytes: prepared.size,
      });
      await api.uploadDocument(ticket, prepared, (loaded, total) => {
        const percent = total <= 0 ? 0 : Math.round((loaded / total) * 100);
        setProgress((current) => ({
          ...current,
          [documentType]: `Uploading ${percent}%`,
        }));
      });
      setProgress((current) => ({ ...current, [documentType]: "Checking document" }));
      await api.completeDocumentUpload(ticket.documentId);
      setLocallyAccepted((current) => [...new Set([...current, documentType])]);
      setProgress((current) => ({
        ...current,
        [documentType]: `${documentType} accepted`,
      }));
      await onAccepted?.();
    } catch {
      setProgress((current) => ({
        ...current,
        [documentType]: `${documentType} upload failed`,
      }));
    } finally {
      event.target.value = "";
    }
  }
  return (
    <section aria-labelledby="documents-heading">
      <h2 id="documents-heading">Documents</h2>
      <p>
        {locallyAccepted.length} of {required.length} documents accepted
      </p>
      {required.map((documentType) => {
        const inputId = `${idPrefix}-${documentType}`;
        return (
          <div key={documentType}>
            <label htmlFor={inputId}>{documentType} evidence</label>
            <span id={`${inputId}-hint`} className="hint">
              Images are resized and compressed before upload.
            </span>
            <input
              id={inputId}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-describedby={`${inputId}-hint`}
              disabled={locallyAccepted.includes(documentType)}
              onChange={(event) => void selected(documentType, event)}
            />
            {progress[documentType] ? (
              <p role="status">{progress[documentType]}</p>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
