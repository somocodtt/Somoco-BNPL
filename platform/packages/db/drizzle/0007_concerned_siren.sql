ALTER TABLE "privacy"."document" DROP CONSTRAINT "document_accepted_has_clean_evidence";--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ALTER COLUMN "provider_reference" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ALTER COLUMN "checked_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD COLUMN "accepted_object_key" text;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD COLUMN "accepted_object_version_id" text;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD COLUMN "accepted_object_etag" text;--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD COLUMN "provider_correlation_id" uuid;--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD COLUMN "consent_evidence_id" uuid;--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD COLUMN "processing_token" uuid;--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "privacy"."otp_challenge" ADD COLUMN "delivery_failed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "privacy"."identity_check"
SET "provider_correlation_id" = "id";--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ALTER COLUMN "provider_correlation_id" SET NOT NULL;--> statement-breakpoint
UPDATE "privacy"."document"
SET "status" = 'QUARANTINED'::document_status,
    "malware_scanned" = false,
    "metadata" = "metadata" || jsonb_build_object(
      'legacyAcceptedEvidence', true,
      'migrationReason', 'IMMUTABLE_OBJECT_IDENTITY_UNAVAILABLE'
    ),
    "updated_at" = now()
WHERE "status" = 'ACCEPTED';--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD CONSTRAINT "identity_check_consent_evidence_id_consent_evidence_id_fk" FOREIGN KEY ("consent_evidence_id") REFERENCES "privacy"."consent_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_accepted_object_identity_unique" ON "privacy"."document" USING btree ("accepted_object_key","accepted_object_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_check_provider_idempotency_unique" ON "privacy"."identity_check" USING btree ("provider","idempotency_key");--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD CONSTRAINT "document_accepted_has_clean_evidence" CHECK ("privacy"."document"."status" <> 'ACCEPTED' or ("privacy"."document"."malware_scanned" and "privacy"."document"."sha256" is not null and "privacy"."document"."accepted_object_key" is not null and "privacy"."document"."accepted_object_version_id" is not null and "privacy"."document"."accepted_object_etag" is not null));--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD CONSTRAINT "identity_check_processing_lease_consistent" CHECK (("privacy"."identity_check"."processing_token" is null) = ("privacy"."identity_check"."processing_started_at" is null));--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD CONSTRAINT "identity_check_final_result_complete" CHECK ("privacy"."identity_check"."status" = 'PENDING' or ("privacy"."identity_check"."provider_reference" is not null and "privacy"."identity_check"."checked_at" is not null) or ("privacy"."identity_check"."status" = 'FAILED' and "privacy"."identity_check"."checked_at" is not null));--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_accepted_document_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'ACCEPTED' THEN
    RAISE EXCEPTION 'accepted document evidence is immutable' USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER document_accepted_immutable
BEFORE UPDATE OR DELETE ON "privacy"."document"
FOR EACH ROW EXECUTE FUNCTION prevent_accepted_document_mutation();
