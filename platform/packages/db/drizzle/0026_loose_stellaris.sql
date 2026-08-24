CREATE TABLE "migration_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_batch_id" uuid NOT NULL,
	"migration_record_id" uuid,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"actor_staff_user_id" uuid,
	"request_id" uuid,
	"reason_code" text,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_event_type_allowed" CHECK ("migration_event"."event_type" in ('IMPORTED', 'VALIDATED', 'SAMPLED', 'APPROVED', 'ACTIVATED', 'QUARANTINED', 'CORRECTED'))
);
--> statement-breakpoint
CREATE TABLE "report_export_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_export_id" uuid NOT NULL,
	"event_key" text NOT NULL,
	"event_type" text NOT NULL,
	"content_hash" text,
	"artifact" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "report_export_event_type_allowed" CHECK ("report_export_event"."event_type" in ('QUEUED', 'READY', 'FAILED')),
	CONSTRAINT "report_export_event_content_hash_sha256" CHECK ("report_export_event"."content_hash" is null or "report_export_event"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "migration_batch" ADD COLUMN "batch_fingerprint" text;--> statement-breakpoint
ALTER TABLE "migration_record" ADD COLUMN "row_fingerprint" text;--> statement-breakpoint
ALTER TABLE "migration_event" ADD CONSTRAINT "migration_event_migration_batch_id_migration_batch_id_fk" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_event" ADD CONSTRAINT "migration_event_migration_record_id_migration_record_id_fk" FOREIGN KEY ("migration_record_id") REFERENCES "public"."migration_record"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_event" ADD CONSTRAINT "migration_event_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_export_event" ADD CONSTRAINT "report_export_event_report_export_id_report_export_id_fk" FOREIGN KEY ("report_export_id") REFERENCES "public"."report_export"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "migration_event_key_unique" ON "migration_event" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "migration_event_batch_created_idx" ON "migration_event" USING btree ("migration_batch_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "report_export_event_key_unique" ON "report_export_event" USING btree ("event_key");--> statement-breakpoint
CREATE INDEX "report_export_event_export_created_idx" ON "report_export_event" USING btree ("report_export_id","created_at");--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_row_fingerprint_sha256" CHECK ("migration_record"."row_fingerprint" is null or "migration_record"."row_fingerprint" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
ALTER TABLE "migration_batch" ADD CONSTRAINT "migration_batch_fingerprint_sha256" CHECK ("migration_batch"."batch_fingerprint" is null or "migration_batch"."batch_fingerprint" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "migration_event", "report_export_event" TO somo_runtime;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "migration_event", "report_export_event" FROM somo_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_task13_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task 13 evidence is append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER migration_event_append_only
BEFORE UPDATE OR DELETE ON "migration_event"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER report_export_event_append_only
BEFORE UPDATE OR DELETE ON "report_export_event"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "migration_record", "report_export", "migration_event", "report_export_event" FROM somo_runtime;
