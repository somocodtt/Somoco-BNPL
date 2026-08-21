import { createDatabase, type Database } from "@somo/db";
import type { Writable } from "node:stream";
import fastify, { type FastifyInstance, LogController } from "fastify";
import { type AppConfig, loadConfig, validateConfig } from "./config.js";
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
  type MalwareScannerPort,
  type NiaPort,
  type ObjectStoragePort,
  type SmsPort,
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
  contracts?: {
    template?: ContractTemplateAttestation;
    headOffice?: { id: string; location: string };
  };
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config =
    options.config === undefined
      ? loadConfig()
      : validateConfig(options.config);
  if (
    config.environment === "production" &&
    options.financing?.fixtureGate !== undefined &&
    (!isTrustedFinanceApprovalGate(options.financing.fixtureGate) ||
      !isProductionFinanceApprovalGate(options.financing.fixtureGate))
  ) {
    throw new Error("PRODUCTION_FIXTURE_GATE_REQUIRED");
  }
  assertProductionIdentityDependencies(config, options.identity);
  const connection =
    options.database === undefined
      ? createDatabase(config.databaseUrl)
      : undefined;
  const database = options.database ?? connection!.db;
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

  if (connection !== undefined) {
    app.addHook("onClose", async () => {
      await connection.close();
    });
  }

  await registerRequestContext(app);
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
  const assetService = createAssetService({ database });
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
  return app;
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
