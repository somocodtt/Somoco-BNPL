ALTER TABLE "privacy"."document" ALTER COLUMN "sha256" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD COLUMN "declared_mime_type" text;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD COLUMN "declared_size_bytes" integer;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD COLUMN "upload_ticket_hash" text;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD COLUMN "upload_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "privacy"."document"
SET "declared_mime_type" = 'application/octet-stream',
    "declared_size_bytes" = 1,
    "upload_ticket_hash" = repeat('0', 64),
    "upload_expires_at" = "created_at",
    "sha256" = CASE
      WHEN "sha256" ~ '^[0-9a-f]{64}$' THEN "sha256"
      ELSE NULL
    END,
    "status" = CASE
      WHEN "status" IN ('UPLOADED', 'SCANNING', 'ACCEPTED')
        THEN 'QUARANTINED'::document_status
      ELSE "status"
    END,
    "malware_scanned" = CASE
      WHEN "status" IN ('UPLOADED', 'SCANNING', 'ACCEPTED') THEN false
      ELSE "malware_scanned"
    END,
    "metadata" = "metadata" || jsonb_build_object(
      'legacyUploadEvidence', true,
      'migrationReason', 'UPLOAD_BINDING_UNAVAILABLE'
    );--> statement-breakpoint
ALTER TABLE "privacy"."document" ALTER COLUMN "declared_mime_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."document" ALTER COLUMN "declared_size_bytes" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."document" ALTER COLUMN "upload_ticket_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."document" ALTER COLUMN "upload_expires_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD CONSTRAINT "document_declared_size_positive" CHECK ("privacy"."document"."declared_size_bytes" > 0);--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD CONSTRAINT "document_upload_ticket_hash_sha256" CHECK ("privacy"."document"."upload_ticket_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD CONSTRAINT "document_sha256_when_present" CHECK ("privacy"."document"."sha256" is null or "privacy"."document"."sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD CONSTRAINT "document_accepted_has_clean_evidence" CHECK ("privacy"."document"."status" <> 'ACCEPTED' or ("privacy"."document"."malware_scanned" and "privacy"."document"."sha256" is not null));--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "privacy"."consent_evidence" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "privacy"."consent_evidence" FROM somo_runtime;--> statement-breakpoint
CREATE TRIGGER consent_evidence_append_only
BEFORE UPDATE OR DELETE ON "privacy"."consent_evidence"
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
