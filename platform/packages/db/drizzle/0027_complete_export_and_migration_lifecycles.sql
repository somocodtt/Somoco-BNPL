ALTER TABLE "report_export_event" ADD COLUMN "reason_code" text;
--> statement-breakpoint
ALTER TABLE "report_export_event" ADD CONSTRAINT "report_export_event_reason_code_safe" CHECK ("reason_code" is null or "reason_code" ~ '^[A-Z][A-Z0-9_]{0,63}$');
--> statement-breakpoint
CREATE TABLE "migration_batch_transition" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "migration_batch_id" uuid NOT NULL,
  "event_key" text NOT NULL,
  "event_type" text NOT NULL,
  "status" text NOT NULL,
  "imported_records" integer DEFAULT 0 NOT NULL,
  "expected_total_minor_units" bigint NOT NULL,
  "reconciled_total_minor_units" bigint NOT NULL,
  "sample_required" integer NOT NULL,
  "sample_passed" integer NOT NULL,
  "verified_by" uuid,
  "verified_at" timestamp with time zone,
  "approved_by" uuid,
  "approved_at" timestamp with time zone,
  "financial_evidence_hash" text,
  "activated_at" timestamp with time zone,
  "actor_staff_user_id" uuid,
  "request_id" uuid,
  "reason_code" text,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "migration_batch_transition_event_type_allowed" CHECK ("event_type" in ('IMPORTED', 'VALIDATED', 'SAMPLED', 'APPROVED', 'ACTIVATED', 'QUARANTINED', 'REJECTED', 'CORRECTED')),
  CONSTRAINT "migration_batch_transition_status_allowed" CHECK ("status" in ('QUARANTINED', 'VALIDATED', 'APPROVED', 'IMPORTED', 'REJECTED')),
  CONSTRAINT "migration_batch_transition_totals_nonnegative" CHECK ("expected_total_minor_units" >= 0 and "reconciled_total_minor_units" >= 0),
  CONSTRAINT "migration_batch_transition_sample_counts_nonnegative" CHECK ("sample_required" >= 0 and "sample_passed" >= 0 and "sample_passed" <= "sample_required"),
  CONSTRAINT "migration_batch_transition_financial_hash_sha256" CHECK ("financial_evidence_hash" is null or "financial_evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "migration_sample_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "migration_batch_id" uuid NOT NULL,
  "migration_record_id" uuid NOT NULL,
  "verifier_staff_user_id" uuid NOT NULL,
  "verified_at" timestamp with time zone DEFAULT now() NOT NULL,
  "result" text NOT NULL,
  "evidence_hash" text,
  CONSTRAINT "migration_sample_evidence_result_allowed" CHECK ("result" in ('PASS', 'FAIL')),
  CONSTRAINT "migration_sample_evidence_hash_sha256" CHECK ("evidence_hash" is null or "evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "migration_batch_transition" ADD CONSTRAINT "migration_batch_transition_migration_batch_id_migration_batch_id_fk" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_batch_transition" ADD CONSTRAINT "migration_batch_transition_verified_by_staff_user_id_fk" FOREIGN KEY ("verified_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_batch_transition" ADD CONSTRAINT "migration_batch_transition_approved_by_staff_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_batch_transition" ADD CONSTRAINT "migration_batch_transition_actor_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence" ADD CONSTRAINT "migration_sample_evidence_migration_batch_id_migration_batch_id_fk" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batch"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence" ADD CONSTRAINT "migration_sample_evidence_migration_record_id_migration_record_id_fk" FOREIGN KEY ("migration_record_id") REFERENCES "public"."migration_record"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence" ADD CONSTRAINT "migration_sample_evidence_verifier_staff_user_id_staff_user_id_fk" FOREIGN KEY ("verifier_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_batch_transition_key_unique" ON "migration_batch_transition" USING btree ("event_key");
--> statement-breakpoint
CREATE INDEX "migration_batch_transition_batch_created_idx" ON "migration_batch_transition" USING btree ("migration_batch_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_sample_evidence_row_unique" ON "migration_sample_evidence" USING btree ("migration_batch_id", "migration_record_id");
--> statement-breakpoint
CREATE INDEX "migration_sample_evidence_batch_idx" ON "migration_sample_evidence" USING btree ("migration_batch_id", "verified_at");
--> statement-breakpoint
INSERT INTO "migration_batch_transition"
  (migration_batch_id, event_key, event_type, status, imported_records,
   expected_total_minor_units, reconciled_total_minor_units, sample_required,
   sample_passed, verified_by, verified_at, approved_by, approved_at,
   financial_evidence_hash, activated_at, actor_staff_user_id, data, created_at)
SELECT id, 'migration:' || id || ':BASELINE', 'CORRECTED', status,
       imported_records, expected_total_minor_units,
       reconciled_total_minor_units, sample_required, sample_passed,
       verified_by, verified_at, approved_by, approved_at,
       financial_evidence_hash, activated_at, uploader_staff_user_id,
       '{"backfilled":true}'::jsonb, created_at
  FROM migration_batch
ON CONFLICT (event_key) DO NOTHING;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "migration_batch", "migration_batch_transition", "migration_sample_evidence" FROM somo_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "migration_batch_transition", "migration_sample_evidence" TO somo_runtime;
--> statement-breakpoint
CREATE TRIGGER migration_batch_append_only
BEFORE UPDATE OR DELETE ON "migration_batch"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER migration_batch_transition_append_only
BEFORE UPDATE OR DELETE ON "migration_batch_transition"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER migration_sample_evidence_append_only
BEFORE UPDATE OR DELETE ON "migration_sample_evidence"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
