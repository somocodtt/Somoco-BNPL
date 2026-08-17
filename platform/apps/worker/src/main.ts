import { pathToFileURL } from "node:url";
import { createDatabase, type Database } from "@somo/db";
import { createDatabaseOutboxStore } from "./database-outbox-store.js";
import {
  dispatchOutboxBatch,
  inspectOutboxHandlerProvenance,
  inspectOutboxHandlerRegistration,
  validateDispatchOutboxOptions,
  type OutboxClaimStore,
  type OutboxHandler,
  type WorkerLogger,
} from "./jobs/dispatch-outbox.js";

export interface StartWorkerOptions {
  store: OutboxClaimStore;
  workerId: string;
  handlers: ReadonlyMap<string, OutboxHandler>;
  logger: WorkerLogger;
  concurrency?: number;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  heartbeatIntervalMs?: number;
  claimLeaseMs?: number;
  pollIntervalMs?: number;
  now?: () => Date;
  signal?: AbortSignal;
}

export interface WorkerController {
  readonly completion: Promise<void>;
  stop(): Promise<void>;
}

export interface WorkerProcessConfig {
  databaseUrl: string;
  workerId: string;
  handlersModule: string;
  environment: "development" | "test" | "production";
}

export interface WorkerHandlerModuleContext {
  database: Database;
}

export type WorkerHandlerFactory = (
  context: WorkerHandlerModuleContext,
) =>
  | ReadonlyMap<string, OutboxHandler>
  | Promise<ReadonlyMap<string, OutboxHandler>>;

export function startWorker(options: StartWorkerOptions): WorkerController {
  let stopping = false;
  let wakePoll: (() => void) | undefined;
  const requestStop = () => {
    stopping = true;
    wakePoll?.();
  };
  const configuration = {
    store: options.store,
    workerId: options.workerId,
    handlers: options.handlers,
    logger: options.logger,
    concurrency: options.concurrency ?? 4,
    maxAttempts: options.maxAttempts ?? 5,
    retryBaseDelayMs: options.retryBaseDelayMs ?? 1_000,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 10_000,
    claimLeaseMs: options.claimLeaseMs ?? 30_000,
    pollIntervalMs: options.pollIntervalMs ?? 1_000,
    now: options.now ?? (() => new Date()),
  };
  validateDispatchOutboxOptions(configuration);
  if (
    !Number.isInteger(configuration.pollIntervalMs) ||
    configuration.pollIntervalMs < 1
  ) {
    throw new Error("WORKER_POLL_INTERVAL_INVALID");
  }

  const signal = options.signal;
  signal?.addEventListener("abort", requestStop, { once: true });

  const completion = (async () => {
    options.logger.info({
      event: "worker.started",
      workerId: options.workerId,
      concurrency: configuration.concurrency,
    });
    try {
      while (!stopping && !signal?.aborted) {
        try {
          const claimed = await dispatchOutboxBatch(configuration);
          if (claimed === 0 && !stopping) {
            await waitForPoll(configuration.pollIntervalMs, (wake) => {
              wakePoll = wake;
            });
            wakePoll = undefined;
          }
        } catch (cause) {
          options.logger.error({
            event: "worker.iteration_failed",
            workerId: options.workerId,
            failureCode: "WORKER_ITERATION_FAILED",
          });
          if (!stopping) {
            await waitForPoll(configuration.pollIntervalMs, (wake) => {
              wakePoll = wake;
            });
            wakePoll = undefined;
          }
          void cause;
        }
      }
    } finally {
      signal?.removeEventListener("abort", requestStop);
      options.logger.info({
        event: "worker.stopped",
        workerId: options.workerId,
      });
    }
  })();

  return Object.freeze({
    completion,
    stop: async () => {
      requestStop();
      await completion;
    },
  });
}

export function readWorkerProcessConfig(
  environment: Readonly<Record<string, string | undefined>>,
): WorkerProcessConfig {
  const databaseUrl = requiredEnvironmentValue(
    environment.DATABASE_URL,
    "WORKER_DATABASE_URL_REQUIRED",
  );
  const workerId = requiredEnvironmentValue(
    environment.WORKER_ID,
    "WORKER_ID_REQUIRED",
  );
  const handlersModule = requiredEnvironmentValue(
    environment.WORKER_HANDLERS_MODULE,
    "WORKER_HANDLERS_MODULE_REQUIRED",
  );
  const runtimeEnvironment = workerEnvironment(environment.NODE_ENV);
  return Object.freeze({
    databaseUrl,
    workerId,
    handlersModule,
    environment: runtimeEnvironment,
  });
}

export function validateWorkerHandlerRegistry(
  environment: WorkerProcessConfig["environment"],
  handlers: ReadonlyMap<string, OutboxHandler>,
): void {
  if (environment !== "production") return;
  for (const handler of handlers.values()) {
    const provenance = inspectOutboxHandlerProvenance(handler);
    if (provenance === "SIMULATOR") {
      throw new Error("WORKER_SIMULATOR_HANDLER_FORBIDDEN");
    }
    if (provenance === "UNDECLARED") {
      throw new Error("WORKER_HANDLER_PROVENANCE_REQUIRED");
    }
  }
  const otpHandler = handlers.get("identity.otp_sms_requested");
  if (otpHandler === undefined) throw new Error("WORKER_OTP_HANDLER_REQUIRED");
  const registration = inspectOutboxHandlerRegistration(otpHandler);
  if (!registration?.capabilities.has("SMS")) {
    throw new Error("WORKER_OTP_SMS_CAPABILITY_REQUIRED");
  }
  if (registration.otpDeliveryPolicy === undefined) {
    throw new Error("WORKER_OTP_POLICY_REQUIRED");
  }
}

export async function runWorkerProcess(
  config: WorkerProcessConfig,
): Promise<void> {
  const connection = createDatabase(config.databaseUrl);
  const stopController = new AbortController();
  const stop = () => stopController.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const handlers = await loadWorkerHandlers(
      config.handlersModule,
      connection.db,
    );
    validateWorkerHandlerRegistry(config.environment, handlers);
    const worker = startWorker({
      store: createDatabaseOutboxStore(connection.db),
      workerId: config.workerId,
      handlers,
      logger: processLogger,
      signal: stopController.signal,
    });
    await worker.completion;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await connection.close();
  }
}

async function loadWorkerHandlers(
  moduleSpecifier: string,
  database: Database,
): Promise<ReadonlyMap<string, OutboxHandler>> {
  const loaded: unknown = await import(moduleSpecifier);
  if (typeof loaded !== "object" || loaded === null) {
    throw new Error("WORKER_HANDLERS_MODULE_INVALID");
  }
  const createWorkerHandlers = (loaded as Record<string, unknown>)[
    "createWorkerHandlers"
  ];
  if (typeof createWorkerHandlers !== "function") {
    throw new Error("WORKER_HANDLERS_MODULE_INVALID");
  }
  const handlers: unknown = await (
    createWorkerHandlers as WorkerHandlerFactory
  )({ database });
  if (!(handlers instanceof Map)) {
    throw new Error("WORKER_HANDLERS_INVALID");
  }
  return handlers;
}

function requiredEnvironmentValue(
  value: string | undefined,
  code: string,
): string {
  if (value === undefined || value.trim().length === 0) throw new Error(code);
  return value;
}

function workerEnvironment(
  value: string | undefined,
): WorkerProcessConfig["environment"] {
  if (value === undefined || value.trim().length === 0) {
    throw new Error("WORKER_NODE_ENV_REQUIRED");
  }
  const environment = value;
  if (!["development", "test", "production"].includes(environment)) {
    throw new Error("WORKER_NODE_ENV_INVALID");
  }
  return environment as WorkerProcessConfig["environment"];
}

const processLoggerImplementation: WorkerLogger = {
  info(record) {
    process.stdout.write(`${JSON.stringify(record)}\n`);
  },
  error(record) {
    process.stderr.write(`${JSON.stringify(record)}\n`);
  },
};
const processLogger = Object.freeze(processLoggerImplementation);

function waitForPoll(
  delayMs: number,
  registerWake: (wake: () => void) => void,
): Promise<void> {
  if (!Number.isInteger(delayMs) || delayMs < 1) {
    return Promise.reject(new Error("WORKER_POLL_INTERVAL_INVALID"));
  }
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    registerWake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export * from "./jobs/dispatch-outbox.js";
export * from "./jobs/recompute-arrears.js";
export * from "./jobs/send-notification.js";
export * from "./database-outbox-store.js";

const entrypoint = process.argv[1];
if (
  entrypoint !== undefined &&
  import.meta.url === pathToFileURL(entrypoint).href
) {
  void runConfiguredWorkerProcess().catch(() => {
    process.stderr.write(
      `${JSON.stringify({ event: "worker.bootstrap_failed", failureCode: "WORKER_BOOTSTRAP_FAILED" })}\n`,
    );
    process.exitCode = 1;
  });
}

async function runConfiguredWorkerProcess(): Promise<void> {
  await runWorkerProcess(readWorkerProcessConfig(process.env));
}
