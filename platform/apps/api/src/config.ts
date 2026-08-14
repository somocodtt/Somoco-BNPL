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
  }
  return Object.freeze({
    ...config,
    allowedOrigins: Object.freeze([...config.allowedOrigins]),
  });
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
