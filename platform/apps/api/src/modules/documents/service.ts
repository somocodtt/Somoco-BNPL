import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  appendAuditEvent,
  createPendingDocument,
  findOwnedDocument,
  transitionDocumentStatus,
  withTransaction,
  type Database,
  type DocumentStatus,
} from "@somo/db";
import type { MalwareScannerPort, ObjectStoragePort } from "@somo/integrations";
import { detectFileMimeType } from "@somo/integrations";
import { AppError } from "../../plugins/errors.js";
import {
  validateDocumentPolicy,
  validateUploadDeclaration,
  type DocumentPolicy,
} from "./policy.js";

export type { DocumentPolicy } from "./policy.js";

export interface UploadTicket {
  documentId: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface DocumentService {
  requestUpload(input: {
    personId: string;
    sessionId?: string;
    documentType: string;
    mimeType: string;
    sizeBytes: number;
    requestId: string;
  }): Promise<UploadTicket>;
  completeUpload(input: {
    personId: string;
    sessionId?: string;
    documentId: string;
    requestId: string;
  }): Promise<{
    documentId: string;
    status: "ACCEPTED";
    sha256: string;
  }>;
  requestDownload(input: {
    personId: string;
    sessionId?: string;
    documentId: string;
    requestId: string;
  }): Promise<{ downloadUrl: string; expiresAt: string }>;
}

export interface DocumentClock {
  now(): Date;
}

export function createDocumentService(options: {
  database: Database;
  storage: ObjectStoragePort;
  malwareScanner: MalwareScannerPort;
  policy: DocumentPolicy;
  clock?: DocumentClock;
}): DocumentService {
  const policy = validateDocumentPolicy(options.policy);
  const clock = options.clock ?? { now: () => new Date() };

  return {
    async requestUpload(input) {
      validateUploadDeclaration(policy, input);
      validateDocumentType(input.documentType);
      const documentId = randomUUID();
      const uploadToken = randomBytes(32).toString("base64url");
      const objectKey = `identity/${input.personId}/${documentId}/${randomUUID()}`;
      const now = clock.now();
      const expiresAt = new Date(now.getTime() + policy.uploadTtlMs);
      const requiredHeaders = Object.freeze({
        "content-length": String(input.sizeBytes),
        "content-type": input.mimeType,
        "x-amz-meta-somo-document-id": documentId,
        "x-amz-meta-somo-person-id": input.personId,
        "x-amz-meta-somo-upload-ticket": uploadToken,
      });
      await withTransaction(options.database, async (tx) => {
        await createPendingDocument(tx, {
          id: documentId,
          personId: input.personId,
          documentType: input.documentType,
          objectKey,
          declaredMimeType: input.mimeType,
          declaredSizeBytes: input.sizeBytes,
          uploadTicketHash: sha256(uploadToken),
          uploadExpiresAt: expiresAt,
          createdAt: now,
        });
        await appendAuditEvent(tx, {
          aggregateType: "document",
          aggregateId: documentId,
          action: "DOCUMENT_UPLOAD_REQUESTED",
          requestId: input.requestId,
          data: auditData(input, {
            subjectPersonId: input.personId,
            documentType: input.documentType,
            declaredMimeType: input.mimeType,
            declaredSizeBytes: input.sizeBytes,
            expiresAt: expiresAt.toISOString(),
          }),
          occurredAt: now,
        });
      });
      try {
        const ticket = await options.storage.createUploadTicket({
          objectKey,
          expiresAt,
          requiredHeaders,
        });
        return {
          documentId,
          uploadUrl: ticket.uploadUrl,
          expiresAt: expiresAt.toISOString(),
          requiredHeaders: ticket.requiredHeaders,
        };
      } catch {
        await transitionWithAudit({
          database: options.database,
          documentId,
          personId: input.personId,
          expectedStatus: "UPLOADED",
          status: "REJECTED",
          malwareScanned: false,
          requestId: input.requestId,
          action: "DOCUMENT_UPLOAD_TICKET_FAILED",
          data: auditData(input, { reason: "STORAGE_UNAVAILABLE" }),
          now: clock.now(),
        });
        throw new AppError(
          503,
          "DOCUMENT_STORAGE_UNAVAILABLE",
          "Document storage is unavailable.",
        );
      }
    },

    async completeUpload(input) {
      const document = await findOwnedOrNotFound(options.database, input);
      if (
        document.status === "ACCEPTED" &&
        document.malwareScanned &&
        document.sha256 !== null
      ) {
        return {
          documentId: document.id,
          status: "ACCEPTED",
          sha256: document.sha256,
        };
      }
      if (document.status !== "UPLOADED") throw documentNotReady();
      const now = clock.now();
      if (now.getTime() >= document.uploadExpiresAt.getTime()) {
        await rejectDocument(
          options.database,
          input,
          "UPLOADED",
          "REJECTED",
          false,
          "DOCUMENT_UPLOAD_EXPIRED",
          now,
        );
        throw new AppError(
          409,
          "DOCUMENT_UPLOAD_EXPIRED",
          "The document upload ticket has expired.",
        );
      }
      try {
        await transitionDocumentStatus(options.database, {
          documentId: document.id,
          personId: document.personId,
          expectedStatus: "UPLOADED",
          status: "SCANNING",
          malwareScanned: false,
          updatedAt: now,
        });
      } catch (error) {
        if (isDocumentStateConflict(error)) throw documentNotReady();
        throw error;
      }

      let stored;
      try {
        stored = await options.storage.readObject({
          objectKey: document.objectKey,
          maxBytes: policy.maxBytes,
        });
      } catch (error) {
        const reason =
          error instanceof Error && error.message === "OBJECT_TOO_LARGE"
            ? "DOCUMENT_TOO_LARGE"
            : "DOCUMENT_OBJECT_UNAVAILABLE";
        await rejectDocument(
          options.database,
          input,
          "SCANNING",
          "REJECTED",
          false,
          reason,
          clock.now(),
        );
        throw new AppError(
          reason === "DOCUMENT_TOO_LARGE" ? 413 : 409,
          reason,
          reason === "DOCUMENT_TOO_LARGE"
            ? "The document is too large."
            : "The uploaded document is unavailable.",
        );
      }

      const bindingValid =
        stored.metadata["somo-document-id"] === document.id &&
        stored.metadata["somo-person-id"] === document.personId &&
        hashMatches(
          document.uploadTicketHash,
          stored.metadata["somo-upload-ticket"],
        );
      if (!bindingValid) {
        await rejectDocument(
          options.database,
          input,
          "SCANNING",
          "REJECTED",
          false,
          "DOCUMENT_UPLOAD_BINDING_INVALID",
          clock.now(),
        );
        throw new AppError(
          409,
          "DOCUMENT_UPLOAD_BINDING_INVALID",
          "The uploaded document could not be verified.",
        );
      }
      if (
        stored.bytes.byteLength !== document.declaredSizeBytes ||
        stored.contentLength !== document.declaredSizeBytes
      ) {
        await rejectDocument(
          options.database,
          input,
          "SCANNING",
          "REJECTED",
          false,
          "DOCUMENT_SIZE_MISMATCH",
          clock.now(),
        );
        throw new AppError(
          409,
          "DOCUMENT_SIZE_MISMATCH",
          "The uploaded document size does not match its declaration.",
        );
      }
      const detectedMimeType = await detectFileMimeType(stored.bytes);
      if (
        stored.contentType !== document.declaredMimeType ||
        detectedMimeType !== document.declaredMimeType
      ) {
        await rejectDocument(
          options.database,
          input,
          "SCANNING",
          "REJECTED",
          false,
          "DOCUMENT_CONTENT_TYPE_MISMATCH",
          clock.now(),
        );
        throw new AppError(
          409,
          "DOCUMENT_CONTENT_TYPE_MISMATCH",
          "The uploaded document type does not match its declaration.",
        );
      }

      let scan;
      try {
        scan = await options.malwareScanner.scan({
          objectKey: document.objectKey,
          bytes: stored.bytes,
        });
      } catch {
        await rejectDocument(
          options.database,
          input,
          "SCANNING",
          "QUARANTINED",
          false,
          "MALWARE_SCANNER_UNAVAILABLE",
          clock.now(),
        );
        throw new AppError(
          503,
          "MALWARE_SCANNER_UNAVAILABLE",
          "Document scanning is unavailable.",
        );
      }
      if (scan.verdict !== "CLEAN") {
        await rejectDocument(
          options.database,
          input,
          "SCANNING",
          "QUARANTINED",
          scan.verdict === "INFECTED",
          scan.verdict === "INFECTED"
            ? "DOCUMENT_MALWARE_DETECTED"
            : "MALWARE_SCANNER_ERROR",
          clock.now(),
        );
        throw new AppError(
          scan.verdict === "INFECTED" ? 400 : 503,
          scan.verdict === "INFECTED"
            ? "DOCUMENT_MALWARE_DETECTED"
            : "MALWARE_SCANNER_UNAVAILABLE",
          scan.verdict === "INFECTED"
            ? "The document did not pass security scanning."
            : "Document scanning is unavailable.",
        );
      }

      const digest = sha256(stored.bytes);
      const acceptedAt = clock.now();
      const accepted = await transitionWithAudit({
        database: options.database,
        documentId: document.id,
        personId: document.personId,
        expectedStatus: "SCANNING",
        status: "ACCEPTED",
        malwareScanned: true,
        sha256: digest,
        metadata: {
          detectedMimeType,
          scannerReference: scan.scannerReference,
        },
        requestId: input.requestId,
        action: "DOCUMENT_ACCEPTED",
        data: auditData(input, {
          subjectPersonId: document.personId,
          sha256: digest,
          scannerReference: scan.scannerReference,
        }),
        now: acceptedAt,
      });
      return {
        documentId: accepted.id,
        status: "ACCEPTED",
        sha256: digest,
      };
    },

    async requestDownload(input) {
      const now = clock.now();
      const document = await findOwnedDocument(options.database, input);
      if (document === null) {
        await appendAuditEvent(options.database, {
          aggregateType: "document",
          aggregateId: input.documentId,
          action: "DOCUMENT_DOWNLOAD_DENIED",
          requestId: input.requestId,
          data: auditData(input, { reason: "NOT_FOUND_OR_NOT_OWNED" }),
          occurredAt: now,
        });
        throw documentNotFound();
      }
      if (
        document.status !== "ACCEPTED" ||
        !document.malwareScanned ||
        document.sha256 === null
      ) {
        await appendAuditEvent(options.database, {
          aggregateType: "document",
          aggregateId: document.id,
          action: "DOCUMENT_DOWNLOAD_DENIED",
          requestId: input.requestId,
          data: auditData(input, { reason: "NOT_CLEAN" }),
          occurredAt: now,
        });
        throw documentNotReady();
      }
      const expiresAt = new Date(now.getTime() + policy.downloadTtlMs);
      await appendAuditEvent(options.database, {
        aggregateType: "document",
        aggregateId: document.id,
        action: "DOCUMENT_DOWNLOAD_REQUESTED",
        requestId: input.requestId,
        data: auditData(input, {
          subjectPersonId: document.personId,
          expiresAt: expiresAt.toISOString(),
        }),
        occurredAt: now,
      });
      try {
        return await options.storage.createDownloadTicket({
          objectKey: document.objectKey,
          expiresAt,
        });
      } catch {
        throw new AppError(
          503,
          "DOCUMENT_STORAGE_UNAVAILABLE",
          "Document storage is unavailable.",
        );
      }
    },
  };
}

async function findOwnedOrNotFound(
  database: Database,
  input: { documentId: string; personId: string },
) {
  const document = await findOwnedDocument(database, input);
  if (document === null) throw documentNotFound();
  return document;
}

async function rejectDocument(
  database: Database,
  input: {
    documentId: string;
    personId: string;
    sessionId?: string;
    requestId: string;
  },
  expectedStatus: DocumentStatus,
  status: "REJECTED" | "QUARANTINED",
  malwareScanned: boolean,
  reason: string,
  now: Date,
): Promise<void> {
  await transitionWithAudit({
    database,
    documentId: input.documentId,
    personId: input.personId,
    expectedStatus,
    status,
    malwareScanned,
    requestId: input.requestId,
    action: "DOCUMENT_REJECTED",
    data: auditData(input, { reason }),
    now,
  });
}

async function transitionWithAudit(input: {
  database: Database;
  documentId: string;
  personId: string;
  expectedStatus: DocumentStatus;
  status: DocumentStatus;
  malwareScanned: boolean;
  sha256?: string;
  metadata?: Readonly<Record<string, unknown>>;
  requestId: string;
  action: string;
  data: Readonly<Record<string, unknown>>;
  now: Date;
}) {
  return withTransaction(input.database, async (tx) => {
    const updated = await transitionDocumentStatus(tx, {
      documentId: input.documentId,
      personId: input.personId,
      expectedStatus: input.expectedStatus,
      status: input.status,
      malwareScanned: input.malwareScanned,
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      updatedAt: input.now,
    });
    await appendAuditEvent(tx, {
      aggregateType: "document",
      aggregateId: input.documentId,
      action: input.action,
      requestId: input.requestId,
      data: input.data,
      occurredAt: input.now,
    });
    return updated;
  });
}

function auditData(
  input: { personId: string; sessionId?: string },
  data: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    ...data,
    subjectPersonId: input.personId,
    ...(input.sessionId === undefined
      ? {}
      : { customerSessionId: input.sessionId }),
  };
}

function validateDocumentType(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) {
    throw new AppError(
      400,
      "DOCUMENT_TYPE_INVALID",
      "The document type is invalid.",
    );
  }
}

function hashMatches(expectedHash: string, value: string | undefined): boolean {
  if (value === undefined) return false;
  const actual = Buffer.from(sha256(value), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return (
    actual.length === expected.length &&
    timingSafeEqual(Uint8Array.from(actual), Uint8Array.from(expected))
  );
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function documentNotFound(): AppError {
  return new AppError(404, "DOCUMENT_NOT_FOUND", "Document was not found.");
}

function documentNotReady(): AppError {
  return new AppError(
    409,
    "DOCUMENT_NOT_READY",
    "Document is not available for use.",
  );
}

function isDocumentStateConflict(error: unknown): boolean {
  return error instanceof Error && error.message === "DOCUMENT_STATE_CONFLICT";
}
