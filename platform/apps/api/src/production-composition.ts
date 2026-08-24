import {
  isSimulatorAdapter,
  requireProductionConnector,
  type MalwareScannerPort,
  type NiaPort,
  type ObjectStoragePort,
  type SmsPort,
} from "@somo/integrations";
import {
  validateDocumentPolicy,
  type DocumentPolicy,
} from "./modules/documents/policy.js";
import {
  createConsentDocumentCatalog,
  type ConsentDocumentCatalogConfig,
} from "./modules/identity/consent-catalog.js";
import {
  validateOtpPolicy,
  type OtpPolicy,
} from "./modules/identity/otp-service.js";

export interface ProductionIdentityComposition {
  sms: SmsPort;
  otpPolicy: OtpPolicy;
  consentCatalog: ConsentDocumentCatalogConfig;
  nia: NiaPort;
  documents: {
    storage: ObjectStoragePort;
    malwareScanner: MalwareScannerPort;
    policy: DocumentPolicy;
  };
}

export function validateProductionIdentityComposition(
  value: unknown,
): ProductionIdentityComposition {
  if (!record(value)) throw dependencyError();
  const documents = value["documents"];
  if (
    !record(documents) ||
    value["sms"] === undefined ||
    value["nia"] === undefined ||
    value["otpPolicy"] === undefined ||
    value["consentCatalog"] === undefined ||
    documents["storage"] === undefined ||
    documents["malwareScanner"] === undefined ||
    documents["policy"] === undefined
  ) {
    throw dependencyError();
  }

  const sms = value["sms"];
  const nia = value["nia"];
  const storage = documents["storage"];
  const malwareScanner = documents["malwareScanner"];
  const leaves = [sms, nia, storage, malwareScanner];
  if (leaves.some(isSimulatorAdapter)) {
    throw new Error("SIMULATOR_FORBIDDEN_IN_PRODUCTION");
  }
  if (
    !method(sms, "send") ||
    !method(nia, "verify") ||
    !method(storage, "createUploadTicket") ||
    !method(storage, "readObject") ||
    !method(storage, "promoteToImmutable") ||
    !method(storage, "createDownloadTicket") ||
    !method(malwareScanner, "scan")
  ) {
    throw new Error("PRODUCTION_IDENTITY_CAPABILITY_REQUIRED");
  }
  for (const [adapter, capability] of [
    [sms, "SMS"],
    [nia, "NIA"],
    [storage, "OBJECT_STORAGE"],
    [malwareScanner, "MALWARE_SCANNER"],
  ] as const) {
    try {
      requireProductionConnector(adapter as object, capability);
    } catch {
      throw new Error("PRODUCTION_IDENTITY_PROVENANCE_REQUIRED");
    }
  }

  const otpPolicy = validateOtpPolicy(value["otpPolicy"] as OtpPolicy);
  const consentCatalog = value[
    "consentCatalog"
  ] as ConsentDocumentCatalogConfig;
  createConsentDocumentCatalog(consentCatalog);
  const policy = validateDocumentPolicy(documents["policy"] as DocumentPolicy);
  return Object.freeze({
    sms: sms as SmsPort,
    otpPolicy,
    consentCatalog,
    nia: nia as NiaPort,
    documents: Object.freeze({
      storage: storage as ObjectStoragePort,
      malwareScanner: malwareScanner as MalwareScannerPort,
      policy,
    }),
  });
}

export async function loadProductionIdentityComposition(
  env: Readonly<Record<string, string | undefined>>,
  importer: (specifier: string) => Promise<unknown> = (specifier) =>
    import(specifier),
): Promise<ProductionIdentityComposition> {
  const moduleSpecifier = env.IDENTITY_COMPOSITION_MODULE?.trim();
  if (moduleSpecifier === undefined || moduleSpecifier.length === 0) {
    throw new Error("PRODUCTION_IDENTITY_COMPOSITION_MODULE_REQUIRED");
  }
  const loaded = await importer(moduleSpecifier);
  if (
    !record(loaded) ||
    typeof loaded["createIdentityComposition"] !== "function"
  ) {
    throw new Error("PRODUCTION_IDENTITY_COMPOSITION_MODULE_INVALID");
  }
  const composition = await (
    loaded["createIdentityComposition"] as () => unknown | Promise<unknown>
  )();
  return validateProductionIdentityComposition(composition);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function method(value: unknown, name: string): boolean {
  return record(value) && typeof value[name] === "function";
}

function dependencyError(): Error {
  return new Error("PRODUCTION_IDENTITY_DEPENDENCIES_REQUIRED");
}
