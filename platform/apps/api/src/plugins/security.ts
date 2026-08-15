import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import csrfProtection from "@fastify/csrf-protection";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AppConfig } from "../config.js";

export const redactedLogPaths = Object.freeze([
  "req.headers.authorization",
  "req.headers.cookie",
  "res.headers.set-cookie",
  "body.password",
  "body.mfaAssertion",
  "body.phoneE164",
  "body.code",
  "body.ghanaCardNumber",
]);

export async function registerSecurity(
  app: FastifyInstance,
  config: AppConfig,
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
    hsts: config.cookieSecure,
  });
  await app.register(cors, {
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    origin(origin, callback) {
      callback(
        null,
        origin === undefined || config.allowedOrigins.includes(origin),
      );
    },
  });
  await app.register(cookie, {
    secret: config.cookieSecret,
    hook: "onRequest",
  });
  await app.register(csrfProtection, {
    cookieOpts: {
      httpOnly: true,
      path: "/v1/staff",
      sameSite: "strict",
      secure: config.cookieSecure,
      signed: true,
    },
    getToken(request: FastifyRequest) {
      const token = request.headers["x-csrf-token"];
      return typeof token === "string" ? token : undefined;
    },
  });
  await app.register(rateLimit, {
    global: false,
    max: config.rateLimitMax,
    timeWindow: config.rateLimitWindowMs,
  });
}
