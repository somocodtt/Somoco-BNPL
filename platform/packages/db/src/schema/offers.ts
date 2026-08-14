import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { application } from "./applications.js";
import { financingRuleVersion } from "./products.js";

export const offer = pgTable(
  "offer",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    applicationId: uuid("application_id")
      .notNull()
      .references(() => application.id, { onDelete: "restrict" }),
    acceptedVersionId: uuid("accepted_version_id"),
    version: integer("version").notNull().default(1),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("offer_application_unique").on(table.applicationId),
    check("offer_version_positive", sql`${table.version} > 0`),
  ],
);

export const offerVersion = pgTable(
  "offer_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    offerId: uuid("offer_id")
      .notNull()
      .references(() => offer.id, { onDelete: "restrict" }),
    financingRuleVersionId: uuid("financing_rule_version_id")
      .notNull()
      .references(() => financingRuleVersion.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    principalMinorUnits: bigint("principal_minor_units", {
      mode: "bigint",
    }).notNull(),
    depositMinorUnits: bigint("deposit_minor_units", {
      mode: "bigint",
    }).notNull(),
    totalPayableMinorUnits: bigint("total_payable_minor_units", {
      mode: "bigint",
    }).notNull(),
    terms: jsonb("terms").$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("offer_version_number_unique").on(
      table.offerId,
      table.versionNumber,
    ),
    check("offer_version_number_positive", sql`${table.versionNumber} > 0`),
    check(
      "offer_principal_nonnegative",
      sql`${table.principalMinorUnits} >= 0`,
    ),
    check("offer_deposit_nonnegative", sql`${table.depositMinorUnits} >= 0`),
    check(
      "offer_total_payable_nonnegative",
      sql`${table.totalPayableMinorUnits} >= 0`,
    ),
  ],
);
