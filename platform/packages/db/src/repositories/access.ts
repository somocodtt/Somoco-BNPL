import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  staffRoleAssignment,
  staffSession,
  staffUser,
  type staffRole,
  type staffUserStatus,
} from "../schema/access.js";
import {
  getInternalExecutor,
  type DatabaseTransaction,
} from "../transaction.js";
import { withTransaction } from "../transaction.js";

export type DatabaseStaffRole = (typeof staffRole.enumValues)[number];
export type DatabaseStaffUserStatus =
  (typeof staffUserStatus.enumValues)[number];

export interface NewStaffUser {
  email: string;
  passwordHash: string;
  roles: readonly DatabaseStaffRole[];
}

export interface StaffUserRecord {
  id: string;
  email: string;
  passwordHash: string;
  status: DatabaseStaffUserStatus;
  version: number;
  roles: readonly DatabaseStaffRole[];
  createdAt: Date;
  updatedAt: Date;
}

export interface NewStaffSession {
  staffUserId: string;
  tokenHash: string;
  mfaVerified: boolean;
  expiresAt: Date;
}

export interface NewStaffSessionForAccessVersion extends NewStaffSession {
  expectedStaffUserVersion: number;
}

export interface ActiveStaffSession {
  id: string;
  staffUserId: string;
  mfaVerified: boolean;
  expiresAt: Date;
  roles: readonly DatabaseStaffRole[];
}

export interface UpdateStaffUserAccess {
  staffUserId: string;
  expectedVersion: number;
  status?: DatabaseStaffUserStatus;
  roles?: readonly DatabaseStaffRole[];
  changedAt: Date;
}

export async function createStaffUser(
  db: Database,
  input: NewStaffUser,
): Promise<StaffUserRecord> {
  return withTransaction(db, (tx) => createStaffUserInTransaction(tx, input));
}

export async function createStaffUserInTransaction(
  tx: DatabaseTransaction,
  input: NewStaffUser,
): Promise<StaffUserRecord> {
  const email = input.email.trim().toLowerCase();
  const [inserted] = await getInternalExecutor(tx)
    .insert(staffUser)
    .values({ email, passwordHash: input.passwordHash })
    .returning();
  if (inserted === undefined) {
    throw new Error("STAFF_USER_CREATE_FAILED");
  }
  await getInternalExecutor(tx)
    .insert(staffRoleAssignment)
    .values(input.roles.map((role) => ({ staffUserId: inserted.id, role })));
  return { ...inserted, roles: Object.freeze([...input.roles]) };
}

export async function findStaffUserByEmail(
  db: Database | DatabaseTransaction,
  email: string,
): Promise<StaffUserRecord | null> {
  const [user] = await getInternalExecutor(db)
    .select()
    .from(staffUser)
    .where(eq(staffUser.email, email.trim().toLowerCase()))
    .limit(1);
  return user === undefined ? null : withRoles(db, user);
}

export async function findStaffUserById(
  db: Database | DatabaseTransaction,
  staffUserId: string,
): Promise<StaffUserRecord | null> {
  const [user] = await getInternalExecutor(db)
    .select()
    .from(staffUser)
    .where(eq(staffUser.id, staffUserId))
    .limit(1);
  return user === undefined ? null : withRoles(db, user);
}

export async function createStaffSession(
  db: Database | DatabaseTransaction,
  input: NewStaffSession,
) {
  const [inserted] = await getInternalExecutor(db)
    .insert(staffSession)
    .values(input)
    .returning();
  if (inserted === undefined) {
    throw new Error("STAFF_SESSION_CREATE_FAILED");
  }
  return inserted;
}

export async function createStaffSessionForAccessVersion(
  tx: DatabaseTransaction,
  input: NewStaffSessionForAccessVersion,
) {
  const [user] = await getInternalExecutor(tx)
    .select({ version: staffUser.version, status: staffUser.status })
    .from(staffUser)
    .where(eq(staffUser.id, input.staffUserId))
    .limit(1)
    .for("update");
  if (
    user === undefined ||
    user.status !== "ACTIVE" ||
    user.version !== input.expectedStaffUserVersion
  ) {
    throw new Error("STAFF_USER_ACCESS_CHANGED");
  }
  return createStaffSession(tx, {
    staffUserId: input.staffUserId,
    tokenHash: input.tokenHash,
    mfaVerified: input.mfaVerified,
    expiresAt: input.expiresAt,
  });
}

export async function findActiveStaffSessionByTokenHash(
  db: Database | DatabaseTransaction,
  tokenHash: string,
  now: Date,
): Promise<ActiveStaffSession | null> {
  const [row] = await getInternalExecutor(db)
    .select({
      id: staffSession.id,
      staffUserId: staffSession.staffUserId,
      mfaVerified: staffSession.mfaVerified,
      expiresAt: staffSession.expiresAt,
    })
    .from(staffSession)
    .innerJoin(staffUser, eq(staffUser.id, staffSession.staffUserId))
    .where(
      and(
        eq(staffSession.tokenHash, tokenHash),
        isNull(staffSession.revokedAt),
        gt(staffSession.expiresAt, now),
        eq(staffUser.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    roles: await selectRoles(db, row.staffUserId),
  };
}

export async function revokeStaffSession(
  db: Database | DatabaseTransaction,
  sessionId: string,
  revokedAt: Date,
): Promise<boolean> {
  const revoked = await getInternalExecutor(db)
    .update(staffSession)
    .set({ revokedAt })
    .where(and(eq(staffSession.id, sessionId), isNull(staffSession.revokedAt)))
    .returning({ id: staffSession.id });
  return revoked.length === 1;
}

export async function revokeAllStaffSessions(
  tx: DatabaseTransaction,
  staffUserId: string,
  revokedAt: Date,
): Promise<number> {
  const revoked = await getInternalExecutor(tx)
    .update(staffSession)
    .set({ revokedAt })
    .where(
      and(
        eq(staffSession.staffUserId, staffUserId),
        isNull(staffSession.revokedAt),
      ),
    )
    .returning({ id: staffSession.id });
  return revoked.length;
}

export async function updateStaffUserAccess(
  tx: DatabaseTransaction,
  input: UpdateStaffUserAccess,
): Promise<StaffUserRecord> {
  const values = {
    updatedAt: input.changedAt,
    version: sql`${staffUser.version} + 1`,
    ...(input.status === undefined ? {} : { status: input.status }),
  };
  const [updated] = await getInternalExecutor(tx)
    .update(staffUser)
    .set(values)
    .where(
      and(
        eq(staffUser.id, input.staffUserId),
        eq(staffUser.version, input.expectedVersion),
      ),
    )
    .returning();
  if (updated === undefined) {
    throw new Error("STAFF_USER_VERSION_CONFLICT");
  }
  if (input.roles !== undefined) {
    await getInternalExecutor(tx)
      .delete(staffRoleAssignment)
      .where(eq(staffRoleAssignment.staffUserId, input.staffUserId));
    await getInternalExecutor(tx)
      .insert(staffRoleAssignment)
      .values(
        input.roles.map((role) => ({ staffUserId: input.staffUserId, role })),
      );
  }
  await revokeAllStaffSessions(tx, input.staffUserId, input.changedAt);
  return {
    ...updated,
    roles: await selectRoles(tx, input.staffUserId),
  };
}

async function withRoles(
  db: Database | DatabaseTransaction,
  user: typeof staffUser.$inferSelect,
): Promise<StaffUserRecord> {
  return { ...user, roles: await selectRoles(db, user.id) };
}

async function selectRoles(
  db: Database | DatabaseTransaction,
  staffUserId: string,
): Promise<readonly DatabaseStaffRole[]> {
  const rows = await getInternalExecutor(db)
    .select({ role: staffRoleAssignment.role })
    .from(staffRoleAssignment)
    .where(eq(staffRoleAssignment.staffUserId, staffUserId))
    .orderBy(asc(staffRoleAssignment.role));
  return Object.freeze(rows.map(({ role }) => role));
}
