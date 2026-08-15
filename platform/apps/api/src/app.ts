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
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config =
    options.config === undefined
      ? loadConfig()
      : validateConfig(options.config);
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
  if (options.identity !== undefined) {
    const otp = createOtpService({
      database,
      sms: options.identity.sms,
      policy: options.identity.otpPolicy,
    });
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
  }
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
