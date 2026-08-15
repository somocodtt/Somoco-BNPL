import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { person } from "./privacy.js";

export const staffUserStatus = pgEnum("staff_user_status", [
  "ACTIVE",
  "DISABLED",
  "LOCKED",
]);

export const staffRole = pgEnum("staff_role", [
  "VERIFICATION_OFFICER",
  "BSM",
  "AGM",
  "CFO",
  "MD",
  "PRODUCT_ADMIN",
  "INVENTORY_OFFICER",
  "FINANCE_OFFICER",
  "RECOVERY_OFFICER",
  "COMPLIANCE_AUDITOR",
  "CUSTOMER_SUPPORT",
  "SYSTEM_ADMIN",
]);

export const staffUser = pgTable(
  "staff_user",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    status: staffUserStatus("status").notNull().default("ACTIVE"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("staff_user_email_unique").on(table.email),
    check("staff_user_version_positive", sql`${table.version} > 0`),
  ],
);

export const staffRoleAssignment = pgTable(
  "staff_role_assignment",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "cascade" }),
    role: staffRole("role").notNull(),
    assignedAt: timestamp("assigned_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("staff_role_assignment_unique").on(
      table.staffUserId,
      table.role,
    ),
  ],
);

export const customerAccount = pgTable(
  "customer_account",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    status: text("status").notNull().default("ACTIVE"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("customer_account_person_unique").on(table.personId),
    check(
      "customer_account_status_allowed",
      sql`${table.status} in ('ACTIVE', 'DISABLED')`,
    ),
    check("customer_account_version_positive", sql`${table.version} > 0`),
  ],
);

export const customerSession = pgTable(
  "customer_session",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    customerAccountId: uuid("customer_account_id")
      .notNull()
      .references(() => customerAccount.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("customer_session_token_hash_unique").on(table.tokenHash),
    index("customer_session_account_idx").on(table.customerAccountId),
    check(
      "customer_session_token_hash_sha256",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "customer_session_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);

export const staffSession = pgTable(
  "staff_session",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUser.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    mfaVerified: boolean("mfa_verified").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("staff_session_token_hash_unique").on(table.tokenHash),
    index("staff_session_user_idx").on(table.staffUserId),
    check(
      "staff_session_token_hash_sha256",
      sql`${table.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "staff_session_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
  ],
);
