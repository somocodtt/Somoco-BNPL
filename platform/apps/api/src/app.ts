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
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config =
    options.config === undefined
      ? loadConfig()
      : validateConfig(options.config);
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
  return app;
}
