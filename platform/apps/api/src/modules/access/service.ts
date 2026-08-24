import { createHash, createHmac, randomBytes } from "node:crypto";
import {
  appendAuditEvent,
  createStaffSessionForAccessVersion,
  createStaffUserInTransaction,
  findActiveStaffSessionByTokenHash,
  findStaffUserByEmail,
  revokeStaffSession,
  updateStaffUserAccess,
  withTransaction,
  type Database,
  type DatabaseStaffUserStatus,
  type StaffUserRecord,
} from "@somo/db";
import argon2 from "argon2";
import type { AppConfig } from "../../config.js";
import { AppError } from "../../plugins/errors.js";
import type { StaffAction } from "./actions.js";
import { authorize, type StaffPrincipal, type StaffRole } from "./policy.js";

export interface MfaVerificationInput {
  staffUserId: string;
  email: string;
  assertion: string;
}

export interface MfaVerifier {
  kind: "production" | "test";
  verify(input: MfaVerificationInput): Promise<boolean>;
}

export interface AccessService {
  authenticateSessionToken(token: string): Promise<StaffPrincipal>;
  createSession(input: {
    email: string;
    password: string;
    mfaAssertion: string;
    requestId: string;
  }): Promise<{
    principal: StaffPrincipal;
    token: string;
    expiresAt: Date;
  }>;
  revokeSession(principal: StaffPrincipal, requestId: string): Promise<void>;
  authorizePrivileged(input: {
    principal: StaffPrincipal;
    action: StaffAction;
    requestId: string;
    targetId?: string;
  }): Promise<void>;
  createUser(input: {
    actor: StaffPrincipal;
    email: string;
    password: string;
    roles: readonly StaffRole[];
    requestId: string;
  }): Promise<StaffUserRecord>;
  updateUser(input: {
    actor: StaffPrincipal;
    staffUserId: string;
    expectedVersion: number;
    status?: DatabaseStaffUserStatus;
    roles?: readonly StaffRole[];
    requestId: string;
  }): Promise<StaffUserRecord>;
}

export async function createAccessService(options: {
  config: AppConfig;
  database: Database;
  mfaVerifier?: MfaVerifier;
}): Promise<AccessService> {
  const { config, database, mfaVerifier } = options;
  const dummyPasswordHash = await hashPassword(
    randomBytes(32).toString("base64url"),
    config,
  );

  return {
    async authenticateSessionToken(token) {
      const session = await findActiveStaffSessionByTokenHash(
        database,
        hashSessionToken(token),
        new Date(),
      );
      if (session === null || !session.mfaVerified) {
        throw authenticationError();
      }
      return {
        kind: "staff",
        staffUserId: session.staffUserId,
        roles: session.roles,
        sessionId: session.id,
      };
    },

    async createSession(input) {
      if (
        mfaVerifier === undefined ||
        (config.environment === "production" &&
          mfaVerifier.kind !== "production")
      ) {
        throw new AppError(
          503,
          "MFA_VERIFIER_UNAVAILABLE",
          "Staff authentication is unavailable.",
        );
      }

      const email = normalizeEmail(input.email);
      const user = await findStaffUserByEmail(database, email);
      const passwordHash = user?.passwordHash ?? dummyPasswordHash;
      const passwordVerified = await argon2.verify(
        passwordHash,
        input.password,
      );
      if (user === null || !passwordVerified || user.status !== "ACTIVE") {
        await auditAuthenticationDenial(
          database,
          email,
          config.auditTargetHmacSecret,
          input.requestId,
        );
        throw authenticationError();
      }

      const mfaVerified = await mfaVerifier.verify({
        staffUserId: user.id,
        email: user.email,
        assertion: input.mfaAssertion,
      });
      if (!mfaVerified) {
        await auditAuthenticationDenial(
          database,
          email,
          config.auditTargetHmacSecret,
          input.requestId,
        );
        throw authenticationError();
      }

      const token = randomBytes(32).toString("base64url");
      const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1_000);
      const now = new Date();
      let session;
      try {
        session = await withTransaction(database, async (tx) => {
          const created = await createStaffSessionForAccessVersion(tx, {
            staffUserId: user.id,
            expectedStaffUserVersion: user.version,
            tokenHash: hashSessionToken(token),
            mfaVerified,
            expiresAt,
          });
          await appendAuditEvent(tx, {
            aggregateType: "staff_session",
            aggregateId: created.id,
            action: "STAFF_SESSION_CREATED",
            actorStaffUserId: user.id,
            requestId: input.requestId,
            data: { mfaVerified: true },
            occurredAt: now,
          });
          return created;
        });
      } catch (error) {
        if (!isStaffUserAccessChanged(error)) {
          throw error;
        }
        await auditAuthenticationDenial(
          database,
          email,
          config.auditTargetHmacSecret,
          input.requestId,
        );
        throw authenticationError();
      }
      return {
        principal: {
          kind: "staff",
          staffUserId: user.id,
          roles: user.roles,
          sessionId: session.id,
        },
        token,
        expiresAt,
      };
    },

    async revokeSession(principal, requestId) {
      const now = new Date();
      await withTransaction(database, async (tx) => {
        await revokeStaffSession(tx, principal.sessionId, now);
        await appendAuditEvent(tx, {
          aggregateType: "staff_session",
          aggregateId: principal.sessionId,
          action: "STAFF_SESSION_REVOKED",
          actorStaffUserId: principal.staffUserId,
          requestId,
          data: {},
          occurredAt: now,
        });
      });
    },

    async authorizePrivileged(input) {
      const aggregateId = input.targetId ?? input.principal.staffUserId;
      const now = new Date();
      try {
        authorize(input.principal, input.action);
      } catch {
        await appendAuditEvent(database, {
          aggregateType: "access_control",
          aggregateId,
          action: "ACCESS_DENIED",
          actorStaffUserId: input.principal.staffUserId,
          requestId: input.requestId,
          data: { action: input.action, roles: [...input.principal.roles] },
          occurredAt: now,
        });
        throw new AppError(403, "FORBIDDEN", "Action is not permitted.");
      }
      await appendAuditEvent(database, {
        aggregateType: "access_control",
        aggregateId,
        action: "ACCESS_ALLOWED",
        actorStaffUserId: input.principal.staffUserId,
        requestId: input.requestId,
        data: { action: input.action },
        occurredAt: now,
      });
    },

    async createUser(input) {
      const email = normalizeEmail(input.email);
      validateRoles(input.roles);
      const passwordHash = await hashPassword(input.password, config);
      try {
        return await withTransaction(database, async (tx) => {
          const created = await createStaffUserInTransaction(tx, {
            email,
            passwordHash,
            roles: input.roles,
          });
          await appendAuditEvent(tx, {
            aggregateType: "staff_user",
            aggregateId: created.id,
            action: "STAFF_USER_CREATED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: { email: created.email, roles: [...created.roles] },
            occurredAt: new Date(),
          });
          return created;
        });
      } catch (error) {
        if (databaseErrorCode(error) === "23505") {
          throw new AppError(
            409,
            "STAFF_USER_ALREADY_EXISTS",
            "A staff user with that email already exists.",
          );
        }
        throw error;
      }
    },

    async updateUser(input) {
      if (input.status === undefined && input.roles === undefined) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "A status or roles change is required.",
        );
      }
      if (input.roles !== undefined) {
        validateRoles(input.roles);
      }
      const now = new Date();
      try {
        return await withTransaction(database, async (tx) => {
          const updated = await updateStaffUserAccess(tx, {
            staffUserId: input.staffUserId,
            expectedVersion: input.expectedVersion,
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.roles === undefined ? {} : { roles: input.roles }),
            changedAt: now,
          });
          await appendAuditEvent(tx, {
            aggregateType: "staff_user",
            aggregateId: updated.id,
            action: "STAFF_USER_UPDATED",
            actorStaffUserId: input.actor.staffUserId,
            requestId: input.requestId,
            data: {
              status: updated.status,
              roles: [...updated.roles],
              revokedSessions: true,
            },
            occurredAt: now,
          });
          return updated;
        });
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "STAFF_USER_VERSION_CONFLICT"
        ) {
          throw new AppError(
            409,
            "STAFF_USER_VERSION_CONFLICT",
            "The staff user changed before this update was applied.",
          );
        }
        throw error;
      }
    },
  };
}

async function hashPassword(
  password: string,
  config: AppConfig,
): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: config.argon2MemoryCostKiB,
    timeCost: config.argon2TimeCost,
    parallelism: config.argon2Parallelism,
  });
}

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (
    normalized.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
  ) {
    throw new AppError(400, "VALIDATION_ERROR", "Email is invalid.");
  }
  return normalized;
}

function validateRoles(roles: readonly StaffRole[]): void {
  if (roles.length === 0 || new Set(roles).size !== roles.length) {
    throw new AppError(
      400,
      "VALIDATION_ERROR",
      "Roles must be unique and nonempty.",
    );
  }
}

function authenticationError(): AppError {
  return new AppError(
    401,
    "AUTHENTICATION_FAILED",
    "Credentials could not be verified.",
  );
}

async function auditAuthenticationDenial(
  database: Database,
  normalizedEmail: string,
  hmacSecret: string,
  requestId: string,
): Promise<void> {
  await appendAuditEvent(database, {
    aggregateType: "staff_authentication_target",
    aggregateId: authenticationAuditTargetId(normalizedEmail, hmacSecret),
    action: "STAFF_SESSION_DENIED",
    requestId,
    data: { reason: "AUTHENTICATION_REJECTED" },
    occurredAt: new Date(),
  });
}

function authenticationAuditTargetId(
  normalizedEmail: string,
  hmacSecret: string,
): string {
  const digest = createHmac("sha256", hmacSecret)
    .update(normalizedEmail)
    .digest()
    .subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x80;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function databaseErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null; depth += 1) {
    if (typeof current !== "object") {
      return undefined;
    }
    if ("code" in current && typeof current.code === "string") {
      return current.code;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

function isStaffUserAccessChanged(error: unknown): boolean {
  return (
    error instanceof Error && error.message === "STAFF_USER_ACCESS_CHANGED"
  );
}
