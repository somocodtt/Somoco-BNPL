import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const identityCheckStatus = pgEnum("identity_check_status", [
  "PENDING",
  "VERIFIED",
  "FAILED",
  "MANUAL_REVIEW",
]);

export const documentStatus = pgEnum("document_status", [
  "UPLOADED",
  "SCANNING",
  "ACCEPTED",
  "REJECTED",
  "QUARANTINED",
]);

export const privacySchema = pgSchema("privacy");

export const person = privacySchema.table(
  "person",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    phoneE164: text("phone_e164").notNull(),
    emailCiphertext: text("email_ciphertext"),
    fullNameCiphertext: text("full_name_ciphertext"),
    ghanaCardCiphertext: text("ghana_card_ciphertext"),
    ghanaCardFingerprint: text("ghana_card_fingerprint"),
    dateOfBirthCiphertext: text("date_of_birth_ciphertext"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("person_phone_e164_unique").on(table.phoneE164),
    uniqueIndex("person_ghana_card_fingerprint_unique")
      .on(table.ghanaCardFingerprint)
      .where(sql`${table.ghanaCardFingerprint} is not null`),
    check("person_version_positive", sql`${table.version} > 0`),
  ],
);

export const identityCheck = privacySchema.table(
  "identity_check",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    providerReference: text("provider_reference").notNull(),
    status: identityCheckStatus("status").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("identity_check_provider_reference_unique").on(
      table.provider,
      table.providerReference,
    ),
    index("identity_check_person_idx").on(table.personId),
  ],
);

export const document = privacySchema.table(
  "document",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    documentType: text("document_type").notNull(),
    objectKey: text("object_key").notNull(),
    sha256: text("sha256").notNull(),
    status: documentStatus("status").notNull().default("UPLOADED"),
    malwareScanned: boolean("malware_scanned").notNull().default(false),
    metadata: jsonb("metadata")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("document_object_key_unique").on(table.objectKey),
    index("document_person_idx").on(table.personId),
    check("document_version_positive", sql`${table.version} > 0`),
  ],
);

export const consentEvidence = privacySchema.table(
  "consent_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    policyVersion: text("policy_version").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }).notNull(),
    withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  },
  (table) => [index("consent_evidence_person_idx").on(table.personId)],
);

export const signatureEvidence = privacySchema.table(
  "signature_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    purpose: text("purpose").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    signedAt: timestamp("signed_at", { withTimezone: true }).notNull(),
  },
  (table) => [index("signature_evidence_person_idx").on(table.personId)],
);
