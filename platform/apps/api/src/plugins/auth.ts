import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AppConfig } from "../config.js";
import type { StaffPrincipal } from "../modules/access/policy.js";
import type { AccessService } from "../modules/access/service.js";
import { AppError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    staffPrincipal?: StaffPrincipal;
  }
}

export function createStaffAuthenticationHook(
  service: AccessService,
  config: AppConfig,
): preHandlerHookHandler {
  return async function authenticateStaff(request: FastifyRequest) {
    const signedToken = request.cookies[config.cookieName];
    if (signedToken === undefined) {
      throw authenticationError();
    }
    const unsigned = request.unsignCookie(signedToken);
    if (!unsigned.valid) {
      throw authenticationError();
    }
    request.staffPrincipal = await service.authenticateSessionToken(
      unsigned.value,
    );
  };
}

export function requireStaffPrincipal(request: FastifyRequest): StaffPrincipal {
  if (request.staffPrincipal === undefined) {
    throw authenticationError();
  }
  return request.staffPrincipal;
}

function authenticationError(): AppError {
  return new AppError(
    401,
    "AUTHENTICATION_FAILED",
    "Credentials could not be verified.",
  );
}
