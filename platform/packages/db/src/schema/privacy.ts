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

export const otpChallenge = privacySchema.table(
  "otp_challenge",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    personId: uuid("person_id")
      .notNull()
      .references(() => person.id, { onDelete: "restrict" }),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index("otp_challenge_person_created_idx").on(
      table.personId,
      table.createdAt,
    ),
    check(
      "otp_challenge_code_hash_sha256",
      sql`${table.codeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check("otp_challenge_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "otp_challenge_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
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
    declaredMimeType: text("declared_mime_type").notNull(),
    declaredSizeBytes: integer("declared_size_bytes").notNull(),
    uploadTicketHash: text("upload_ticket_hash").notNull(),
    uploadExpiresAt: timestamp("upload_expires_at", {
      withTimezone: true,
    }).notNull(),
    sha256: text("sha256"),
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
    check(
      "document_declared_size_positive",
      sql`${table.declaredSizeBytes} > 0`,
    ),
    check(
      "document_upload_ticket_hash_sha256",
      sql`${table.uploadTicketHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "document_sha256_when_present",
      sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "document_accepted_has_clean_evidence",
      sql`${table.status} <> 'ACCEPTED' or (${table.malwareScanned} and ${table.sha256} is not null)`,
    ),
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
