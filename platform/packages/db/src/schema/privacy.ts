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
    deliveryFailedAt: timestamp("delivery_failed_at", { withTimezone: true }),
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
    idempotencyKey: text("idempotency_key"),
    providerCorrelationId: uuid("provider_correlation_id").notNull(),
    providerReference: text("provider_reference"),
    consentEvidenceId: uuid("consent_evidence_id").references(
      () => consentEvidence.id,
      { onDelete: "restrict" },
    ),
    status: identityCheckStatus("status").notNull(),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    processingToken: uuid("processing_token"),
    processingStartedAt: timestamp("processing_started_at", {
      withTimezone: true,
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("identity_check_provider_reference_unique").on(
      table.provider,
      table.providerReference,
    ),
    uniqueIndex("identity_check_provider_idempotency_unique").on(
      table.provider,
      table.idempotencyKey,
    ),
    index("identity_check_person_idx").on(table.personId),
    check(
      "identity_check_processing_lease_consistent",
      sql`(${table.processingToken} is null) = (${table.processingStartedAt} is null)`,
    ),
    check(
      "identity_check_final_result_complete",
      sql`${table.status} = 'PENDING' or (${table.providerReference} is not null and ${table.checkedAt} is not null) or (${table.status} = 'FAILED' and ${table.checkedAt} is not null)`,
    ),
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
    acceptedObjectKey: text("accepted_object_key"),
    acceptedObjectVersionId: text("accepted_object_version_id"),
    acceptedObjectEtag: text("accepted_object_etag"),
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
    uniqueIndex("document_accepted_object_identity_unique").on(
      table.acceptedObjectKey,
      table.acceptedObjectVersionId,
    ),
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
      sql`${table.status} <> 'ACCEPTED' or (${table.malwareScanned} and ${table.sha256} is not null and ${table.acceptedObjectKey} is not null and ${table.acceptedObjectVersionId} is not null and ${table.acceptedObjectEtag} is not null)`,
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

export const privacyRequestEvidence = privacySchema.table(
  "privacy_request_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id").notNull(),
    subjectType: text("subject_type").notNull(),
    requestType: text("request_type").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("privacy_request_subject_idx").on(table.subjectId, table.createdAt),
    check(
      "privacy_request_subject_type_allowed",
      sql`${table.subjectType} in ('APPLICANT', 'GUARANTOR')`,
    ),
    check(
      "privacy_request_type_allowed",
      sql`${table.requestType} in ('ACCESS', 'CORRECTION', 'RESTRICTION')`,
    ),
  ],
);

export const privacyRequestEvent = privacySchema.table(
  "privacy_request_event",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => privacyRequestEvidence.id, { onDelete: "restrict" }),
    status: text("status").notNull(),
    actorId: uuid("actor_id").notNull(),
    evidence: jsonb("evidence")
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("privacy_request_event_request_idx").on(
      table.requestId,
      table.occurredAt,
    ),
    check(
      "privacy_request_event_status_allowed",
      sql`${table.status} in ('OPEN', 'IN_REVIEW', 'COMPLETED', 'REJECTED', 'CLOSED')`,
    ),
  ],
);

export const privacyCorrectionEvidence = privacySchema.table(
  "privacy_correction_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => privacyRequestEvidence.id, { onDelete: "restrict" }),
    subjectId: uuid("subject_id").notNull(),
    field: text("field").notNull(),
    proposedValue: jsonb("proposed_value").$type<unknown>().notNull(),
    reason: text("reason").notNull(),
    version: integer("version").notNull(),
    recordedBy: uuid("recorded_by").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("privacy_correction_subject_field_version_unique").on(
      table.subjectId,
      table.field,
      table.version,
    ),
    index("privacy_correction_request_idx").on(table.requestId),
    check("privacy_correction_version_positive", sql`${table.version} > 0`),
  ],
);

export const privacyRestrictionEvidence = privacySchema.table(
  "privacy_restriction_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    requestId: uuid("request_id")
      .notNull()
      .references(() => privacyRequestEvidence.id, { onDelete: "restrict" }),
    subjectId: uuid("subject_id").notNull(),
    reason: text("reason").notNull(),
    requestedBy: uuid("requested_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
  },
  (table) => [index("privacy_restriction_subject_idx").on(table.subjectId)],
);

export const privacyLegalHoldEvidence = privacySchema.table(
  "privacy_legal_hold_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id").notNull(),
    action: text("action").notNull(),
    reason: text("reason"),
    actorId: uuid("actor_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("privacy_legal_hold_subject_idx").on(
      table.subjectId,
      table.occurredAt,
    ),
    check(
      "privacy_legal_hold_action_allowed",
      sql`${table.action} in ('PLACED', 'RELEASED')`,
    ),
  ],
);

export const privacyRetentionPolicyEvidence = privacySchema.table(
  "privacy_retention_policy_evidence",
  {
    version: text("version").primaryKey(),
    retentionDays: integer("retention_days").notNull(),
    approvedBy: uuid("approved_by").notNull(),
    approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    check("privacy_retention_days_positive", sql`${table.retentionDays} > 0`),
  ],
);

export const privacySubjectRetentionEvidence = privacySchema.table(
  "privacy_subject_retention_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    subjectId: uuid("subject_id").notNull(),
    policyVersion: text("policy_version")
      .notNull()
      .references(() => privacyRetentionPolicyEvidence.version, {
        onDelete: "restrict",
      }),
    action: text("action").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    uniqueIndex("privacy_subject_anonymized_unique")
      .on(table.subjectId)
      .where(sql`${table.action} = 'ANONYMIZED'`),
    check(
      "privacy_subject_retention_action_allowed",
      sql`${table.action} = 'ANONYMIZED'`,
    ),
  ],
);

export const privacyRetentionRunEvidence = privacySchema.table(
  "privacy_retention_run_evidence",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    policyVersion: text("policy_version")
      .notNull()
      .references(() => privacyRetentionPolicyEvidence.version, {
        onDelete: "restrict",
      }),
    actorId: uuid("actor_id").notNull(),
    asOf: timestamp("as_of", { withTimezone: true }).notNull(),
    evaluated: integer("evaluated").notNull(),
    anonymized: integer("anonymized").notNull(),
    retained: integer("retained").notNull(),
    skippedLegalHold: integer("skipped_legal_hold").notNull(),
    immutableEvidenceRetained: integer("immutable_evidence_retained").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    index("privacy_retention_run_policy_idx").on(
      table.policyVersion,
      table.createdAt,
    ),
    check(
      "privacy_retention_run_counts_nonnegative",
      sql`${table.evaluated} >= 0 and ${table.anonymized} >= 0 and ${table.retained} >= 0 and ${table.skippedLegalHold} >= 0 and ${table.immutableEvidenceRetained} >= 0`,
    ),
  ],
);
