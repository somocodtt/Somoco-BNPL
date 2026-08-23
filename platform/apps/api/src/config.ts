export type AppEnvironment = "development" | "production" | "test";

export interface AppConfig {
  environment: AppEnvironment;
  host: string;
  port: number;
  databaseUrl: string;
  allowedOrigins: readonly string[];
  cookieName: string;
  cookieSecret: string;
  auditTargetHmacSecret: string;
  cookieSecure: boolean;
  bodyLimitBytes: number;
  rateLimitMax: number;
  rateLimitWindowMs: number;
  sessionTtlSeconds: number;
  argon2MemoryCostKiB: number;
  argon2TimeCost: number;
  argon2Parallelism: number;
  requireVerifiedMfa: boolean;
  /** Names are configuration evidence only; adapter instances are injected separately. */
  niaAdapter?: string;
  smsAdapter?: string;
  paymentAdapter?: string;
  objectStoragePublic?: boolean;
  encryptionKeyRef?: string;
  backupLastVerifiedAt?: string;
  mainHeadOfficeId?: string;
  mainHeadOfficeLocation?: string;
}

export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  const environment = env.NODE_ENV;
  if (
    environment !== "development" &&
    environment !== "production" &&
    environment !== "test"
  ) {
    throw new Error("NODE_ENV must be development, production, or test");
  }

  return validateConfig({
    environment,
    host: required(env.API_HOST, "API_HOST"),
    port: integer(env.API_PORT, "API_PORT"),
    databaseUrl: required(env.DATABASE_URL, "DATABASE_URL"),
    allowedOrigins: required(env.ALLOWED_ORIGINS, "ALLOWED_ORIGINS")
      .split(",")
      .map((origin) => origin.trim()),
    cookieName: required(env.STAFF_COOKIE_NAME, "STAFF_COOKIE_NAME"),
    cookieSecret: required(env.COOKIE_SECRET, "COOKIE_SECRET"),
    auditTargetHmacSecret: required(
      env.AUDIT_TARGET_HMAC_SECRET,
      "AUDIT_TARGET_HMAC_SECRET",
    ),
    cookieSecure: boolean(env.COOKIE_SECURE, "COOKIE_SECURE"),
    bodyLimitBytes: integer(env.BODY_LIMIT_BYTES, "BODY_LIMIT_BYTES"),
    rateLimitMax: integer(env.RATE_LIMIT_MAX, "RATE_LIMIT_MAX"),
    rateLimitWindowMs: integer(
      env.RATE_LIMIT_WINDOW_MS,
      "RATE_LIMIT_WINDOW_MS",
    ),
    sessionTtlSeconds: integer(
      env.STAFF_SESSION_TTL_SECONDS,
      "STAFF_SESSION_TTL_SECONDS",
    ),
    argon2MemoryCostKiB: integer(
      env.ARGON2_MEMORY_COST_KIB,
      "ARGON2_MEMORY_COST_KIB",
    ),
    argon2TimeCost: integer(env.ARGON2_TIME_COST, "ARGON2_TIME_COST"),
    argon2Parallelism: integer(env.ARGON2_PARALLELISM, "ARGON2_PARALLELISM"),
    requireVerifiedMfa: boolean(
      env.REQUIRE_VERIFIED_MFA,
      "REQUIRE_VERIFIED_MFA",
    ),
    ...(environment === "production"
      ? {
          niaAdapter: required(env.NIA_ADAPTER, "NIA_ADAPTER"),
          smsAdapter: required(env.SMS_ADAPTER, "SMS_ADAPTER"),
          paymentAdapter: required(env.PAYMENT_ADAPTER, "PAYMENT_ADAPTER"),
          objectStoragePublic: boolean(
            env.OBJECT_STORAGE_PUBLIC,
            "OBJECT_STORAGE_PUBLIC",
          ),
          encryptionKeyRef: required(
            env.ENCRYPTION_KEY_REF ?? env.ENCRYPTION_KEY_REFERENCE,
            "ENCRYPTION_KEY_REF",
          ),
          backupLastVerifiedAt: required(
            env.BACKUP_LAST_VERIFIED_AT ?? env.BACKUP_VERIFICATION_AT,
            "BACKUP_LAST_VERIFIED_AT",
          ),
        }
      : {
          ...(env.NIA_ADAPTER === undefined
            ? {}
            : { niaAdapter: env.NIA_ADAPTER.trim() }),
          ...(env.SMS_ADAPTER === undefined
            ? {}
            : { smsAdapter: env.SMS_ADAPTER.trim() }),
          ...(env.PAYMENT_ADAPTER === undefined
            ? {}
            : { paymentAdapter: env.PAYMENT_ADAPTER.trim() }),
          ...(env.OBJECT_STORAGE_PUBLIC === undefined
            ? {}
            : {
                objectStoragePublic: boolean(
                  env.OBJECT_STORAGE_PUBLIC,
                  "OBJECT_STORAGE_PUBLIC",
                ),
              }),
          ...(env.ENCRYPTION_KEY_REF === undefined &&
          env.ENCRYPTION_KEY_REFERENCE === undefined
            ? {}
            : {
                encryptionKeyRef: required(
                  env.ENCRYPTION_KEY_REF ?? env.ENCRYPTION_KEY_REFERENCE,
                  "ENCRYPTION_KEY_REF",
                ),
              }),
          ...(env.BACKUP_LAST_VERIFIED_AT === undefined &&
          env.BACKUP_VERIFICATION_AT === undefined
            ? {}
            : {
                backupLastVerifiedAt: required(
                  env.BACKUP_LAST_VERIFIED_AT ?? env.BACKUP_VERIFICATION_AT,
                  "BACKUP_LAST_VERIFIED_AT",
                ),
              }),
        }),
    ...(env.SOMOCO_MAIN_HEAD_OFFICE_ID === undefined &&
    env.SOMOCO_MAIN_HEAD_OFFICE_LOCATION === undefined
      ? {}
      : {
          mainHeadOfficeId: required(
            env.SOMOCO_MAIN_HEAD_OFFICE_ID,
            "SOMOCO_MAIN_HEAD_OFFICE_ID",
          ),
          mainHeadOfficeLocation: required(
            env.SOMOCO_MAIN_HEAD_OFFICE_LOCATION,
            "SOMOCO_MAIN_HEAD_OFFICE_LOCATION",
          ),
        }),
  });
}

export function validateConfig(config: AppConfig): AppConfig {
  required(config.host, "host");
  required(config.databaseUrl, "databaseUrl");
  new URL(config.databaseUrl);
  if (!config.databaseUrl.startsWith("postgresql://")) {
    throw new Error("databaseUrl must use postgresql://");
  }
  if (config.allowedOrigins.length === 0) {
    throw new Error("allowedOrigins must not be empty");
  }
  for (const origin of config.allowedOrigins) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      parsed.username !== "" ||
      parsed.password !== ""
    ) {
      throw new Error("allowedOrigins must contain origins only");
    }
    if (config.environment === "production" && parsed.protocol !== "https:") {
      throw new Error("production allowedOrigins must use HTTPS");
    }
  }
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.cookieName)) {
    throw new Error("cookieName is invalid");
  }
  if (config.cookieSecret.length < 32) {
    throw new Error("cookieSecret must be at least 32 characters");
  }
  if (config.auditTargetHmacSecret.length < 32) {
    throw new Error("auditTargetHmacSecret must be at least 32 characters");
  }
  if (config.environment === "test" && config.port === 0) {
    // Port zero is an explicit synthetic-test sentinel; production never accepts it.
  } else {
    positiveInteger(config.port, "port", 65_535);
  }
  positiveInteger(config.bodyLimitBytes, "bodyLimitBytes", 10_485_760);
  positiveInteger(config.rateLimitMax, "rateLimitMax", 10_000);
  positiveInteger(config.rateLimitWindowMs, "rateLimitWindowMs", 86_400_000);
  positiveInteger(config.sessionTtlSeconds, "sessionTtlSeconds", 604_800);
  positiveInteger(config.argon2MemoryCostKiB, "argon2MemoryCostKiB", 1_048_576);
  positiveInteger(config.argon2TimeCost, "argon2TimeCost", 10);
  positiveInteger(config.argon2Parallelism, "argon2Parallelism", 16);
  if (config.argon2MemoryCostKiB < 19_456 || config.argon2TimeCost < 2) {
    throw new Error("Argon2 parameters are below the security minimum");
  }
  if (config.environment === "production") {
    if (!config.cookieSecure) {
      throw new Error("production cookies must be Secure");
    }
    if (!config.requireVerifiedMfa) {
      throw new Error("production staff sessions must require verified MFA");
    }
    validateAdapterName(config.niaAdapter);
    validateAdapterName(config.smsAdapter);
    validateAdapterName(config.paymentAdapter);
    if (config.niaAdapter === undefined || config.niaAdapter.trim() === "")
      throw new Error("PRODUCTION_NIA_ADAPTER_REQUIRED");
    if (config.smsAdapter === undefined || config.smsAdapter.trim() === "")
      throw new Error("PRODUCTION_SMS_ADAPTER_REQUIRED");
    if (
      config.paymentAdapter === undefined ||
      config.paymentAdapter.trim() === ""
    )
      throw new Error("PRODUCTION_PAYMENT_ADAPTER_REQUIRED");
    if (config.objectStoragePublic !== false) {
      if (config.objectStoragePublic === true)
        throw new Error("PRODUCTION_OBJECT_STORAGE_MUST_BE_PRIVATE");
      throw new Error("PRODUCTION_OBJECT_STORAGE_CONFIGURATION_REQUIRED");
    }
    if (
      config.encryptionKeyRef === undefined ||
      config.encryptionKeyRef.trim() === ""
    ) {
      throw new Error("PRODUCTION_ENCRYPTION_KEY_REFERENCE_REQUIRED");
    }
    if (config.backupLastVerifiedAt === undefined) {
      throw new Error("PRODUCTION_BACKUP_VERIFICATION_REQUIRED");
    }
    validateBackupVerification(config.backupLastVerifiedAt);
  }
  if (
    (config.mainHeadOfficeId === undefined) !==
    (config.mainHeadOfficeLocation === undefined)
  ) {
    throw new Error(
      "mainHeadOfficeId and mainHeadOfficeLocation must be configured together",
    );
  }
  return Object.freeze({
    ...config,
    allowedOrigins: Object.freeze([...config.allowedOrigins]),
  });
}

function validateAdapterName(value: string | undefined): void {
  if (value === undefined || value.trim() === "") return;
  if (/simulator/i.test(value) || /wrapped[-_]?simulator/i.test(value)) {
    throw new Error("PRODUCTION_SIMULATOR_ADAPTER_FORBIDDEN");
  }
}

function validateBackupVerification(value: string): void {
  const verifiedAt = new Date(value);
  if (Number.isNaN(verifiedAt.getTime())) {
    throw new Error("PRODUCTION_BACKUP_VERIFICATION_INVALID");
  }
  const ageMs = Date.now() - verifiedAt.getTime();
  if (ageMs < 0 || ageMs > 48 * 60 * 60 * 1_000) {
    throw new Error("PRODUCTION_BACKUP_VERIFICATION_STALE");
  }
}

function required(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function integer(value: string | undefined, name: string): number {
  const parsed = Number(required(value, name));
  if (!Number.isInteger(parsed)) {
    throw new Error(`${name} must be an integer`);
  }
  return parsed;
}

function boolean(value: string | undefined, name: string): boolean {
  const parsed = required(value, name);
  if (parsed !== "true" && parsed !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return parsed === "true";
}

function positiveInteger(value: number, name: string, maximum: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > maximum) {
    throw new Error(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
}
