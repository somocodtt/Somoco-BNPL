CREATE TABLE "report_export" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"requester_staff_user_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"report_type" text NOT NULL,
	"format" text NOT NULL,
	"data_classification" text NOT NULL,
	"filters" jsonb NOT NULL,
	"row_count" integer NOT NULL,
	"content_hash" text NOT NULL,
	"artifact" jsonb NOT NULL,
	"status" text DEFAULT 'READY' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_export_type_allowed" CHECK ("report_export"."report_type" in ('OPERATIONS', 'PORTFOLIO', 'AUDIT', 'MIGRATION')),
	CONSTRAINT "report_export_format_allowed" CHECK ("report_export"."format" in ('CSV', 'JSON')),
	CONSTRAINT "report_export_classification_allowed" CHECK ("report_export"."data_classification" in ('REDACTED', 'PERSONAL_DATA')),
	CONSTRAINT "report_export_status_allowed" CHECK ("report_export"."status" in ('QUEUED', 'READY', 'FAILED')),
	CONSTRAINT "report_export_row_count_nonnegative" CHECK ("report_export"."row_count" >= 0),
	CONSTRAINT "report_export_content_hash_sha256" CHECK ("report_export"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "source_file_hash" text;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "template_version" text DEFAULT 'legacy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "schema_version" text DEFAULT 'legacy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "source_file_name" text;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "uploader_staff_user_id" uuid;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "expected_total_minor_units" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "reconciled_total_minor_units" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "control_total_hash" text;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "sample_required" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "sample_passed" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "financial_evidence_hash" text;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "normalized_row" jsonb;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "source_row_number" integer;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "source_file_hash" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "template_version" text DEFAULT 'legacy-v1' NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "amount_minor_units" bigint;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "legacy_customer_id" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "legacy_guarantor_id" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "legacy_contract_id" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "legacy_vehicle_id" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "attachment_document_id" uuid;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "attachment_object_key" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "attachment_object_version_id" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "attachment_object_etag" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "match_candidates" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "validation_outcomes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "verified_by" uuid;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "activated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "report_export" ADD CONSTRAINT "report_export_requester_staff_user_id_staff_user_id_fk" FOREIGN KEY ("requester_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "report_export_requester_idx" ON "report_export" USING btree ("requester_staff_user_id","created_at");--> statement-breakpoint
CREATE INDEX "report_export_request_idx" ON "report_export" USING btree ("request_id");--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_batch_uploader_staff_user_id_staff_user_id_fk" FOREIGN KEY ("uploader_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_batch_verified_by_staff_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_batch_approved_by_staff_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_attachment_document_id_document_id_fk" FOREIGN KEY ("attachment_document_id") REFERENCES "privacy"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_verified_by_staff_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_approved_by_staff_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "migration_record_source_hash_idx" ON "migration_record" USING btree ("source_file_hash","template_version");--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_source_file_hash_sha256" CHECK ("migration_batch"."source_file_hash" is null or "migration_batch"."source_file_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_control_total_hash_sha256" CHECK ("migration_batch"."control_total_hash" is null or "migration_batch"."control_total_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_financial_evidence_hash_sha256" CHECK ("migration_batch"."financial_evidence_hash" is null or "migration_batch"."financial_evidence_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_totals_nonnegative" CHECK ("migration_batch"."expected_total_minor_units" >= 0 and "migration_batch"."reconciled_total_minor_units" >= 0);--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_sample_counts_nonnegative" CHECK ("migration_batch"."sample_required" >= 0 and "migration_batch"."sample_passed" >= 0 and "migration_batch"."sample_passed" <= "migration_batch"."sample_required");--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_source_hash_sha256" CHECK ("migration_record"."source_file_hash" is null or "migration_record"."source_file_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_payload_hash_sha256" CHECK ("migration_record"."payload_hash" is null or "migration_record"."payload_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_amount_nonnegative" CHECK ("migration_record"."amount_minor_units" is null or "migration_record"."amount_minor_units" >= 0);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'somo_runtime') THEN
    CREATE ROLE somo_runtime NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "migration_batch", "migration_record", "report_export" TO somo_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_task13_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'migration_record' AND TG_OP = 'UPDATE' THEN
    IF NEW.migration_batch_id IS DISTINCT FROM OLD.migration_batch_id
       OR NEW.source_record_id IS DISTINCT FROM OLD.source_record_id
       OR NEW.payload IS DISTINCT FROM OLD.payload
       OR NEW.source_row_number IS DISTINCT FROM OLD.source_row_number
       OR NEW.source_file_hash IS DISTINCT FROM OLD.source_file_hash
       OR NEW.template_version IS DISTINCT FROM OLD.template_version
       OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
       OR NEW.amount_minor_units IS DISTINCT FROM OLD.amount_minor_units
       OR NEW.legacy_customer_id IS DISTINCT FROM OLD.legacy_customer_id
       OR NEW.legacy_guarantor_id IS DISTINCT FROM OLD.legacy_guarantor_id
       OR NEW.legacy_contract_id IS DISTINCT FROM OLD.legacy_contract_id
       OR NEW.legacy_vehicle_id IS DISTINCT FROM OLD.legacy_vehicle_id
       OR NEW.attachment_document_id IS DISTINCT FROM OLD.attachment_document_id
       OR NEW.attachment_object_key IS DISTINCT FROM OLD.attachment_object_key
       OR NEW.attachment_object_version_id IS DISTINCT FROM OLD.attachment_object_version_id
       OR NEW.attachment_object_etag IS DISTINCT FROM OLD.attachment_object_etag
    THEN
      RAISE EXCEPTION 'task 13 source evidence is append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'task 13 evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER migration_record_append_only
BEFORE UPDATE OR DELETE ON "migration_record"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER report_export_append_only
BEFORE UPDATE OR DELETE ON "report_export"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "migration_record", "report_export" FROM somo_runtime;
