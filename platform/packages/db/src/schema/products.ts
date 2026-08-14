import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const repaymentFrequency = pgEnum("repayment_frequency", [
  "WEEKLY",
  "MONTHLY",
]);

export const productStatus = pgEnum("product_status", [
  "DRAFT",
  "ACTIVE",
  "RETIRED",
]);

export const vehicleModel = pgTable(
  "vehicle_model",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    manufacturer: text("manufacturer").notNull(),
    modelName: text("model_name").notNull(),
    modelYear: integer("model_year").notNull(),
    active: boolean("active").notNull().default(true),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("vehicle_model_identity_unique").on(
      table.manufacturer,
      table.modelName,
      table.modelYear,
    ),
    check(
      "vehicle_model_year_valid",
      sql`${table.modelYear} between 1900 and 2200`,
    ),
    check("vehicle_model_version_positive", sql`${table.version} > 0`),
  ],
);

export const product = pgTable(
  "product",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    vehicleModelId: uuid("vehicle_model_id")
      .notNull()
      .references(() => vehicleModel.id, { onDelete: "restrict" }),
    status: productStatus("status").notNull().default("DRAFT"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("product_code_unique").on(table.code),
    index("product_vehicle_model_idx").on(table.vehicleModelId),
    check("product_version_positive", sql`${table.version} > 0`),
  ],
);

export const financingRuleVersion = pgTable(
  "financing_rule_version",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    productId: uuid("product_id")
      .notNull()
      .references(() => product.id, { onDelete: "restrict" }),
    versionNumber: integer("version_number").notNull(),
    minimumDepositMinorUnits: bigint("minimum_deposit_minor_units", {
      mode: "bigint",
    }).notNull(),
    annualRateBps: numeric("annual_rate_bps", {
      precision: 9,
      scale: 0,
    }).notNull(),
    allowedTenuresMonths: jsonb("allowed_tenures_months")
      .$type<number[]>()
      .notNull(),
    repaymentFrequencies: jsonb("repayment_frequencies")
      .$type<Array<"WEEKLY" | "MONTHLY">>()
      .notNull(),
    calculationMethod: text("calculation_method").notNull(),
    approved: boolean("approved").notNull().default(false),
    effectiveFrom: timestamp("effective_from", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("financing_rule_product_version_unique").on(
      table.productId,
      table.versionNumber,
    ),
    check(
      "financing_rule_minimum_deposit_nonnegative",
      sql`${table.minimumDepositMinorUnits} >= 0`,
    ),
    check(
      "financing_rule_rate_bps_nonnegative",
      sql`${table.annualRateBps} >= 0`,
    ),
    check("financing_rule_version_positive", sql`${table.versionNumber} > 0`),
  ],
);
