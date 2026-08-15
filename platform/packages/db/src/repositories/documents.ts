import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { document } from "../schema/privacy.js";
import {
  getInternalExecutor,
  type DatabaseTransaction,
} from "../transaction.js";

export type DocumentStatus = typeof document.$inferSelect.status;

export async function createPendingDocument(
  db: Database | DatabaseTransaction,
  input: {
    id: string;
    personId: string;
    documentType: string;
    objectKey: string;
    declaredMimeType: string;
    declaredSizeBytes: number;
    uploadTicketHash: string;
    uploadExpiresAt: Date;
    createdAt: Date;
  },
) {
  const [created] = await getInternalExecutor(db)
    .insert(document)
    .values({
      ...input,
      status: "UPLOADED",
      malwareScanned: false,
      metadata: {},
      updatedAt: input.createdAt,
    })
    .returning(documentProjection);
  if (created === undefined) throw new Error("DOCUMENT_CREATE_FAILED");
  return created;
}

export async function findOwnedDocument(
  db: Database | DatabaseTransaction,
  input: { documentId: string; personId: string },
) {
  const [record] = await getInternalExecutor(db)
    .select(documentProjection)
    .from(document)
    .where(
      and(
        eq(document.id, input.documentId),
        eq(document.personId, input.personId),
      ),
    )
    .limit(1);
  return record ?? null;
}

export async function transitionDocumentStatus(
  db: Database | DatabaseTransaction,
  input: {
    documentId: string;
    personId: string;
    expectedStatus: DocumentStatus;
    status: DocumentStatus;
    malwareScanned: boolean;
    sha256?: string;
    metadata?: Readonly<Record<string, unknown>>;
    updatedAt: Date;
  },
) {
  const [updated] = await getInternalExecutor(db)
    .update(document)
    .set({
      status: input.status,
      malwareScanned: input.malwareScanned,
      ...(input.sha256 === undefined ? {} : { sha256: input.sha256 }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      version: sql`${document.version} + 1`,
      updatedAt: input.updatedAt,
    })
    .where(
      and(
        eq(document.id, input.documentId),
        eq(document.personId, input.personId),
        eq(document.status, input.expectedStatus),
      ),
    )
    .returning(documentProjection);
  if (updated === undefined) throw new Error("DOCUMENT_STATE_CONFLICT");
  return updated;
}

const documentProjection = {
  id: document.id,
  personId: document.personId,
  documentType: document.documentType,
  objectKey: document.objectKey,
  declaredMimeType: document.declaredMimeType,
  declaredSizeBytes: document.declaredSizeBytes,
  uploadTicketHash: document.uploadTicketHash,
  uploadExpiresAt: document.uploadExpiresAt,
  sha256: document.sha256,
  status: document.status,
  malwareScanned: document.malwareScanned,
  metadata: document.metadata,
  version: document.version,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
} as const;
