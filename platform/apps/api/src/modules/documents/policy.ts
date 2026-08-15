import { AppError } from "../../plugins/errors.js";

export interface DocumentPolicy {
  allowedMimeTypes: readonly string[];
  maxBytes: number;
  uploadTtlMs: number;
  downloadTtlMs: number;
}

export function validateDocumentPolicy(
  policy: DocumentPolicy,
): Readonly<DocumentPolicy> {
  if (
    policy.allowedMimeTypes.length === 0 ||
    new Set(policy.allowedMimeTypes).size !== policy.allowedMimeTypes.length
  ) {
    throw new Error("document allowedMimeTypes must be unique and nonempty");
  }
  for (const mimeType of policy.allowedMimeTypes) {
    if (
      !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)
    ) {
      throw new Error(
        "document allowedMimeTypes contains an invalid MIME type",
      );
    }
  }
  positiveInteger(policy.maxBytes, "document maxBytes");
  positiveInteger(policy.uploadTtlMs, "document uploadTtlMs");
  positiveInteger(policy.downloadTtlMs, "document downloadTtlMs");
  if (policy.uploadTtlMs > 15 * 60_000) {
    throw new Error("document uploadTtlMs must not exceed 15 minutes");
  }
  if (policy.downloadTtlMs > 5 * 60_000) {
    throw new Error("document downloadTtlMs must not exceed 5 minutes");
  }
  return Object.freeze({
    ...policy,
    allowedMimeTypes: Object.freeze([...policy.allowedMimeTypes]),
  });
}

export function validateUploadDeclaration(
  policy: Readonly<DocumentPolicy>,
  input: { mimeType: string; sizeBytes: number },
): void {
  if (!policy.allowedMimeTypes.includes(input.mimeType)) {
    throw new AppError(
      400,
      "DOCUMENT_TYPE_NOT_ALLOWED",
      "The document type is not allowed.",
    );
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) {
    throw new AppError(
      400,
      "DOCUMENT_SIZE_INVALID",
      "The document size is invalid.",
    );
  }
  if (input.sizeBytes > policy.maxBytes) {
    throw new AppError(413, "DOCUMENT_TOO_LARGE", "The document is too large.");
  }
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
}
