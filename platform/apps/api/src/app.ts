import { createDatabase, probeDatabase, type Database } from "@somo/db";
import type { Writable } from "node:stream";
import fastify, { type FastifyInstance, LogController } from "fastify";
import {
  assertEnvironmentAgreement,
  type AppConfig,
  loadConfig,
  validateConfig,
} from "./config.js";
import { registerAccessRoutes } from "./modules/access/routes.js";
import {
  createAccessService,
  type MfaVerifier,
} from "./modules/access/service.js";
import { registerProblemErrors } from "./plugins/errors.js";
import {
  registerRequestContext,
  requestIdFromHeader,
} from "./plugins/request-context.js";
import { redactedLogPaths, registerSecurity } from "./plugins/security.js";
import {
  requireProductionConnector,
  type AllocationPolicyEvidenceVerifier,
  type MalwareScannerPort,
  type NiaPort,
  type ObjectStoragePort,
  type SmsPort,
  type TrackerPort,
  createTelemetry,
  type Telemetry,
} from "@somo/integrations";
import { validateProductionIdentityComposition } from "./production-composition.js";
import { registerDocumentRoutes } from "./modules/documents/routes.js";
import {
  createDocumentService,
  type DocumentPolicy,
} from "./modules/documents/service.js";
import { createConsentService } from "./modules/identity/consent-service.js";
import type { ConsentDocumentCatalogConfig } from "./modules/identity/consent-catalog.js";
import { createNiaService } from "./modules/identity/nia-service.js";
import { registerIdentityRoutes } from "./modules/identity/routes.js";
import {
  createOtpService,
  type OtpPolicy,
} from "./modules/identity/otp-service.js";
import { createApplicationService } from "./modules/applications/service.js";
import { registerApplicationRoutes } from "./modules/applications/routes.js";
import { registerApprovalRoutes } from "./modules/approvals/routes.js";
import { createApprovalService } from "./modules/approvals/service.js";
import { createUnderwritingService } from "./modules/approvals/underwriting-service.js";
import type { OtpService } from "./modules/identity/otp-service.js";
import { registerProductRoutes } from "./modules/products/routes.js";
import { createProductService } from "./modules/products/service.js";
import { createExceptionService } from "./modules/products/exception-service.js";
import { createOfferService } from "./modules/products/offer-service.js";
import {
  isProductionFinanceApprovalGate,
  isTrustedFinanceApprovalGate,
  type FinanceApprovalGate,
} from "@somo/domain/src/index.js";
import { createAssetService } from "./modules/assets/service.js";
import { registerAssetRoutes } from "./modules/assets/routes.js";
import {
  createContractService,
  type ContractTemplateAttestation,
} from "./modules/contracts/service.js";
import { createHandoverService } from "./modules/contracts/handover-service.js";
import { registerContractRoutes } from "./modules/contracts/routes.js";
import {
  registerPaymentRawBodyParser,
  registerPaymentRoutes,
  type PaymentRouteComposition,
} from "./modules/payments/webhook-routes.js";
import { createPaymentWebhookService } from "./modules/payments/webhook-service.js";
import { createLedgerService } from "./modules/payments/ledger-service.js";
import { createReconciliationService } from "./modules/payments/reconciliation-service.js";
import { createReceiptService } from "./modules/payments/receipt-service.js";
import type { PaymentWebhookVerifier } from "@somo/integrations";
import { registerCollectionsRoutes } from "./modules/collections/routes.js";
import { createCollectionsService } from "./modules/collections/service.js";
import {
  createNotificationService,
  type NotificationService,
} from "./modules/notifications/service.js";
import { createSettlementService } from "./modules/contracts/settlement-service.js";
import { createReportService } from "./modules/reports/service.js";
import { registerReportRoutes } from "./modules/reports/routes.js";
import { createMigrationService } from "./modules/migration/service.js";
import { registerMigrationRoutes } from "./modules/migration/routes.js";
import { registerPrivacyRoutes } from "./modules/privacy/routes.js";
import {
  createPrivacyService,
  type PrivacyService,
} from "./modules/privacy/service.js";

export { authorize } from "./modules/access/policy.js";
export type {
  CustomerPrincipal,
  StaffPrincipal,
  StaffRole,
} from "./modules/access/policy.js";
export type {
  MfaVerificationInput,
  MfaVerifier,
} from "./modules/access/service.js";

export interface BuildAppOptions {
  config?: AppConfig;
  database?: Database;
  logger?: boolean;
  loggerStream?: Writable;
  mfaVerifier?: MfaVerifier;
  identity?: {
    sms: SmsPort;
    otpPolicy: OtpPolicy;
    consentCatalog: ConsentDocumentCatalogConfig;
    nia?: NiaPort;
    documents?: {
      storage: ObjectStoragePort;
      malwareScanner: MalwareScannerPort;
      policy: DocumentPolicy;
    };
  };
  applications?: {
    invitationHashSecret: string;
    invitationTtlMs: number;
    requiredDocumentTypes: readonly string[];
  };
  financing?: { fixtureGate?: FinanceApprovalGate };
  tracker?: TrackerPort;
  contracts?: {
    template?: ContractTemplateAttestation;
    headOffice?: { id: string; location: string };
  };
  payments?: {
    verifier: PaymentWebhookVerifier;
    allocationPolicyEvidenceVerifier?: AllocationPolicyEvidenceVerifier;
    allocationPolicy: import("./modules/payments/ledger-service.js").AllocationPolicy;
    sms: SmsPort;
    accountLinkBaseUrl: string;
    ussdInstructions?: string;
  };
  privacy?: { service: PrivacyService };
  telemetry?: Telemetry;
  dependencyChecks?: readonly {
    name: string;
    check: () => Promise<boolean>;
  }[];
  databaseProbe?: (database: Database) => Promise<boolean>;
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config =
    options.config === undefined
      ? loadConfig()
      : validateConfig(options.config);
  assertEnvironmentAgreement(config.environment, process.env.NODE_ENV);
  const productionRuntime =
    config.environment === "production" ||
    process.env.NODE_ENV === "production";
  if (
    config.environment === "production" &&
    options.financing?.fixtureGate !== undefined &&
    (!isTrustedFinanceApprovalGate(options.financing.fixtureGate) ||
      !isProductionFinanceApprovalGate(options.financing.fixtureGate))
  ) {
    throw new Error("PRODUCTION_FIXTURE_GATE_REQUIRED");
  }
  assertProductionIdentityDependencies(config, options.identity);
  validateProductionPaymentDependencies(config, options.payments);
  const connection =
    options.database === undefined
      ? createDatabase(config.databaseUrl)
      : undefined;
  const database = options.database ?? connection!.db;
  if (productionRuntime && options.privacy?.service === undefined) {
    throw new Error("PRODUCTION_PRIVACY_COMPOSITION_REQUIRED");
  }
  const telemetry = options.telemetry ?? createTelemetry();
  const databaseProbe = options.databaseProbe ?? probeDatabase;
  const databaseReady = await runDatabaseProbe(database, databaseProbe);
  telemetry.setDependency("postgres", databaseReady ? "UP" : "DOWN");
  if (productionRuntime) {
    for (const dependency of [
      "nia",
      "sms",
      "payment",
      "object-storage",
      "malware-scanner",
      "privacy",
    ]) {
      telemetry.setDependency(dependency, "DOWN");
    }
  }
  for (const dependency of options.dependencyChecks ?? []) {
    await refreshDependency(telemetry, dependency);
  }
  const app = fastify({
    ajv: {
      customOptions: {
        removeAdditional: false,
      },
    },
    bodyLimit: config.bodyLimitBytes,
    genReqId(request) {
      return requestIdFromHeader(request.headers["x-request-id"]);
    },
    logger:
      options.logger === false
        ? false
        : {
            level: config.environment === "production" ? "info" : "debug",
            redact: {
              paths: [...redactedLogPaths],
              censor: "[REDACTED]",
            },
            ...(options.loggerStream === undefined
              ? {}
              : { stream: options.loggerStream }),
          },
    logController: new LogController({
      disableRequestLogging: false,
      requestIdLogLabel: "requestId",
    }),
  });

  if (options.payments !== undefined) {
    await registerPaymentRawBodyParser(app);
  }

  if (connection !== undefined) {
    app.addHook("onClose", async () => {
      await connection.close();
    });
  }

  await registerRequestContext(app, telemetry);
  registerHealthRoutes(app, telemetry, {
    database,
    databaseProbe,
    dependencyChecks: options.dependencyChecks ?? [],
  });
  await registerProblemErrors(app);
  await registerSecurity(app, config);
  const accessService = await createAccessService({
    config,
    database,
    ...(options.mfaVerifier === undefined
      ? {}
      : { mfaVerifier: options.mfaVerifier }),
  });
  await registerAccessRoutes(app, config, accessService);
  const approvalService = createApprovalService({ database });
  const underwritingService = createUnderwritingService({ database });
  const productService = createProductService({
    database,
    ...(options.financing?.fixtureGate === undefined
      ? {}
      : { fixtureGate: options.financing.fixtureGate }),
  });
  const exceptionService = createExceptionService({ database });
  const offerService = createOfferService({
    database,
    products: productService,
    exceptions: exceptionService,
    ...(options.financing?.fixtureGate === undefined
      ? {}
      : { fixtureGate: options.financing.fixtureGate }),
  });
  const assetService = createAssetService({
    database,
    environment: config.environment === "production" ? "production" : "test",
    ...(options.tracker === undefined ? {} : { tracker: options.tracker }),
  });
  const configuredHeadOffice =
    options.contracts?.headOffice ??
    (config.mainHeadOfficeId === undefined ||
    config.mainHeadOfficeLocation === undefined
      ? undefined
      : {
          id: config.mainHeadOfficeId,
          location: config.mainHeadOfficeLocation,
        });
  const contractService = createContractService({
    database,
    ...(options.contracts?.template === undefined
      ? {}
      : { template: options.contracts.template }),
    ...(configuredHeadOffice === undefined
      ? {}
      : { headOffice: configuredHeadOffice }),
    environment: config.environment === "production" ? "production" : "test",
  });
  const handoverService = createHandoverService({
    database,
    assets: assetService,
    contracts: contractService,
    ...(configuredHeadOffice === undefined
      ? {}
      : { headOffice: configuredHeadOffice }),
  });
  let customerOtp: Pick<OtpService, "authenticateSessionToken"> | undefined;
  if (options.identity !== undefined) {
    const otp = createOtpService({
      database,
      sms: options.identity.sms,
      policy: options.identity.otpPolicy,
    });
    customerOtp = otp;
    const consent = createConsentService({
      database,
      catalog: options.identity.consentCatalog,
    });
    const nia =
      options.identity.nia === undefined
        ? undefined
        : createNiaService({
            database,
            nia: options.identity.nia,
            catalog: options.identity.consentCatalog,
            idempotencyHashSecret: options.identity.otpPolicy.hashSecret,
          });
    await registerIdentityRoutes(app, config, {
      otp,
      consent,
      ...(nia === undefined ? {} : { nia }),
    });
    if (options.identity.documents !== undefined) {
      const documents = createDocumentService({
        database,
        storage: options.identity.documents.storage,
        malwareScanner: options.identity.documents.malwareScanner,
        policy: options.identity.documents.policy,
      });
      await registerDocumentRoutes(app, otp, documents);
    }
    if (options.applications !== undefined) {
      const applications = createApplicationService({
        database,
        ...options.applications,
      });
      await registerApplicationRoutes(app, otp, applications);
    }
  } else if (options.applications !== undefined) {
    throw new Error("APPLICATION_IDENTITY_COMPOSITION_REQUIRED");
  }
  await registerApprovalRoutes(
    app,
    config,
    accessService,
    approvalService,
    underwritingService,
    customerOtp,
  );
  await registerProductRoutes(
    app,
    config,
    accessService,
    productService,
    exceptionService,
    offerService,
    customerOtp,
  );
  await registerAssetRoutes(app, config, accessService, assetService);
  await registerContractRoutes(
    app,
    config,
    accessService,
    contractService,
    handoverService,
    customerOtp,
  );
  let notifications: NotificationService | undefined;
  if (options.payments !== undefined) {
    const ussdInstructions = options.payments.ussdInstructions;
    if (ussdInstructions === undefined || ussdInstructions.trim() === "")
      throw new Error("PAYMENT_USSD_INSTRUCTIONS_REQUIRED");
    const receipts = createReceiptService({
      database,
      accountLinkBaseUrl: options.payments.accountLinkBaseUrl,
      ussdInstructions,
    });
    notifications = createNotificationService({
      database,
      accountLinkBaseUrl: options.payments.accountLinkBaseUrl,
      ussdInstructions,
    });
    const ledger = createLedgerService({ database, receipts });
    const reconciliation = createReconciliationService({ database });
    const webhook = createPaymentWebhookService({
      database,
      verifier: options.payments.verifier,
      policy: options.payments.allocationPolicy,
      ...(options.payments.allocationPolicyEvidenceVerifier === undefined
        ? {}
        : {
            allocationPolicyEvidenceVerifier:
              options.payments.allocationPolicyEvidenceVerifier,
          }),
      receipts,
    });
    const composition: PaymentRouteComposition = {
      webhook,
      ledger,
      reconciliation,
      receipts,
      ussdInstructions,
    };
    await registerPaymentRoutes(
      app,
      config,
      accessService,
      composition,
      customerOtp,
    );
  } else if (config.environment === "production") {
    throw new Error("PRODUCTION_PAYMENT_COMPOSITION_REQUIRED");
  }
  const collections = createCollectionsService({
    database,
    ...(options.tracker === undefined ? {} : { tracker: options.tracker }),
    ...(options.payments === undefined
      ? {}
      : {
          accountLinkBaseUrl: options.payments.accountLinkBaseUrl,
          ussdInstructions: options.payments.ussdInstructions,
        }),
  });
  const settlement = createSettlementService({ database });
  await registerCollectionsRoutes(
    app,
    config,
    accessService,
    collections,
    settlement,
    notifications,
    customerOtp,
  );
  const reports = createReportService({ database });
  await registerReportRoutes(app, config, accessService, reports);
  const migration = createMigrationService({ database });
  await registerMigrationRoutes(app, config, accessService, migration);
  const privacy = options.privacy?.service ?? createPrivacyService();
  await registerPrivacyRoutes(app, config, accessService, privacy, customerOtp);
  return app;
}

function registerHealthRoutes(
  app: FastifyInstance,
  telemetry: Telemetry,
  readiness: {
    database: Database;
    databaseProbe: (database: Database) => Promise<boolean>;
    dependencyChecks: readonly {
      name: string;
      check: () => Promise<boolean>;
    }[];
  },
): void {
  for (const path of ["/health/live", "/health/liveness"] as const) {
    app.get(path, async (_request, reply) => reply.send(telemetry.liveness()));
  }
  for (const path of ["/health/ready", "/health/readiness"] as const) {
    app.get(path, async (_request, reply) => {
      const status = await refreshReadiness(telemetry, readiness);
      return status.status === "ok"
        ? reply.send(status)
        : reply.code(503).send(status);
    });
  }
}

async function refreshReadiness(
  telemetry: Telemetry,
  readiness: {
    database: Database;
    databaseProbe: (database: Database) => Promise<boolean>;
    dependencyChecks: readonly {
      name: string;
      check: () => Promise<boolean>;
    }[];
  },
): Promise<{ status: "ok" | "not_ready" }> {
  try {
    const databaseReady = await runDatabaseProbe(
      readiness.database,
      readiness.databaseProbe,
    );
    telemetry.setDependency("postgres", databaseReady ? "UP" : "DOWN");
    for (const dependency of readiness.dependencyChecks) {
      await refreshDependency(telemetry, dependency);
    }
    return telemetry.readiness();
  } catch {
    return { status: "not_ready" };
  }
}

async function runDatabaseProbe(
  database: Database,
  databaseProbe: (database: Database) => Promise<boolean>,
): Promise<boolean> {
  try {
    return (await databaseProbe(database)) === true;
  } catch {
    return false;
  }
}

async function refreshDependency(
  telemetry: Telemetry,
  dependency: {
    name: string;
    check: () => Promise<boolean>;
  },
): Promise<void> {
  if (dependency.name.toLowerCase() === "postgres") return;
  try {
    telemetry.setDependency(
      dependency.name,
      (await dependency.check()) === true ? "UP" : "DOWN",
    );
  } catch {
    try {
      telemetry.setDependency(dependency.name, "DOWN");
    } catch {
      // Invalid dependency names remain fail-closed without exposing details.
    }
  }
}

function assertProductionIdentityDependencies(
  config: AppConfig,
  identity: BuildAppOptions["identity"],
): void {
  if (
    config.environment !== "production" &&
    process.env.NODE_ENV !== "production"
  ) {
    return;
  }
  validateProductionIdentityComposition(identity);
}

export function validateProductionPaymentDependencies(
  config: AppConfig,
  payments: BuildAppOptions["payments"],
): void {
  const production =
    config.environment === "production" ||
    process.env.NODE_ENV === "production";
  if (!production) return;
  if (payments === undefined)
    throw new Error("PRODUCTION_PAYMENT_COMPOSITION_REQUIRED");
  if (payments.allocationPolicyEvidenceVerifier === undefined)
    throw new Error("PRODUCTION_ALLOCATION_POLICY_EVIDENCE_VERIFIER_REQUIRED");
  requireProductionConnector(payments.verifier, "PAYMENTS");
  requireProductionConnector(payments.sms, "SMS");
  requireProductionConnector(
    payments.allocationPolicyEvidenceVerifier,
    "ALLOCATION_POLICY_EVIDENCE",
  );
}
