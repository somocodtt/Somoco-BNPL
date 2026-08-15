import type { FastifyRequest, preHandlerHookHandler } from "fastify";
import type { AppConfig } from "../config.js";
import type {
  CustomerPrincipal,
  StaffPrincipal,
} from "../modules/access/policy.js";
import type { AccessService } from "../modules/access/service.js";
import type { OtpService } from "../modules/identity/otp-service.js";
import { AppError } from "./errors.js";

declare module "fastify" {
  interface FastifyRequest {
    staffPrincipal?: StaffPrincipal;
    customerPrincipal?: CustomerPrincipal;
  }
}

export function createCustomerAuthenticationHook(
  service: Pick<OtpService, "authenticateSessionToken">,
): preHandlerHookHandler {
  return async function authenticateCustomer(request: FastifyRequest) {
    const authorization = request.headers.authorization;
    if (authorization === undefined) throw authenticationError();
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (match === null) throw authenticationError();
    request.customerPrincipal = await service.authenticateSessionToken(
      match[1]!,
    );
  };
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

export function requireCustomerPrincipal(
  request: FastifyRequest,
): CustomerPrincipal {
  if (request.customerPrincipal === undefined) {
    throw authenticationError();
  }
  return request.customerPrincipal;
}

function authenticationError(): AppError {
  return new AppError(
    401,
    "AUTHENTICATION_FAILED",
    "Credentials could not be verified.",
  );
}
