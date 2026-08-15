export interface ConsentDocumentCatalogConfig {
  documents: readonly {
    purpose: string;
    currentVersion: string;
  }[];
}

export interface ConsentDocumentCatalog {
  isCurrent(purpose: string, documentVersion: string): boolean;
  currentVersion(purpose: string): string | null;
}

export function createConsentDocumentCatalog(
  input: ConsentDocumentCatalogConfig,
): ConsentDocumentCatalog {
  if (!Array.isArray(input.documents) || input.documents.length === 0) {
    throw new Error("CONSENT_DOCUMENT_CATALOG_REQUIRED");
  }
  const currentByPurpose = new Map<string, string>();
  for (const entry of input.documents) {
    const purpose = entry.purpose.trim();
    const version = entry.currentVersion.trim();
    if (
      !/^[A-Z][A-Z0-9_]{2,63}$/.test(purpose) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(version) ||
      currentByPurpose.has(purpose)
    ) {
      throw new Error("CONSENT_DOCUMENT_CATALOG_INVALID");
    }
    currentByPurpose.set(purpose, version);
  }
  return Object.freeze({
    isCurrent(purpose: string, documentVersion: string) {
      return currentByPurpose.get(purpose) === documentVersion;
    },
    currentVersion(purpose: string) {
      return currentByPurpose.get(purpose) ?? null;
    },
  });
}
