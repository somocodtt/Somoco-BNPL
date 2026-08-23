ALTER TABLE "migration_sample_evidence"
  DROP CONSTRAINT IF EXISTS "migration_sample_evidence_migration_record_id_migration_record_id_fk";
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence"
  ADD COLUMN IF NOT EXISTS "verification_command_id" uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "migration_sample_evidence_quarantine" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "original_evidence_id" uuid NOT NULL,
  "migration_batch_id" uuid NOT NULL,
  "migration_record_id" uuid NOT NULL,
  "verifier_staff_user_id" uuid NOT NULL,
  "verified_at" timestamp with time zone NOT NULL,
  "result" text NOT NULL,
  "verification_command_id" uuid,
  "evidence_hash" text,
  "reason_code" text NOT NULL,
  "reason_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "quarantined_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "migration_sample_evidence_quarantine_result_allowed" CHECK ("migration_sample_evidence_quarantine"."result" in ('PASS', 'FAIL')),
  CONSTRAINT "migration_sample_evidence_quarantine_hash_sha256" CHECK ("migration_sample_evidence_quarantine"."evidence_hash" is null or "migration_sample_evidence_quarantine"."evidence_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "migration_sample_evidence_quarantine_reason_code_safe" CHECK ("migration_sample_evidence_quarantine"."reason_code" ~ '^[A-Z][A-Z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "migration_sample_evidence_quarantine_original_unique"
  ON "migration_sample_evidence_quarantine" USING btree ("original_evidence_id");
--> statement-breakpoint
INSERT INTO "migration_sample_evidence_quarantine"
  (original_evidence_id, migration_batch_id, migration_record_id,
   verifier_staff_user_id, verified_at, result, verification_command_id,
   evidence_hash, reason_code, reason_data)
SELECT e.id, e.migration_batch_id, e.migration_record_id,
       e.verifier_staff_user_id, e.verified_at, e.result,
       e.verification_command_id, e.evidence_hash,
       CASE
         WHEN r.id IS NULL THEN 'CROSS_BATCH_RECORD'
         ELSE 'MISSING_VERIFICATION_COMMAND'
       END,
       jsonb_build_object(
         'crossBatchRecord', r.id IS NULL,
         'missingVerificationCommand', e.verification_command_id IS NULL,
         'requiresReverification', true
       )
  FROM migration_sample_evidence e
  LEFT JOIN migration_record r
    ON r.id = e.migration_record_id
   AND r.migration_batch_id = e.migration_batch_id
 WHERE r.id IS NULL OR e.verification_command_id IS NULL
ON CONFLICT (original_evidence_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence" DISABLE TRIGGER "migration_sample_evidence_append_only";
--> statement-breakpoint
DELETE FROM "migration_sample_evidence" e
 WHERE EXISTS (
   SELECT 1
     FROM "migration_sample_evidence_quarantine" q
    WHERE q.original_evidence_id = e.id
 );
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence" ENABLE TRIGGER "migration_sample_evidence_append_only";
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_record_batch_id_id_unique"
  ON "migration_record" USING btree ("migration_batch_id", "id");
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'migration_sample_evidence_batch_record_fk'
  ) THEN
    ALTER TABLE "migration_sample_evidence"
      ADD CONSTRAINT "migration_sample_evidence_batch_record_fk"
      FOREIGN KEY ("migration_batch_id", "migration_record_id")
      REFERENCES "public"."migration_record"("migration_batch_id", "id")
      ON DELETE restrict ON UPDATE no action;
  END IF;
END $$;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "migration_sample_evidence_quarantine" FROM somo_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE "migration_sample_evidence_quarantine" TO somo_runtime;
--> statement-breakpoint
CREATE TRIGGER migration_sample_evidence_quarantine_append_only
BEFORE UPDATE OR DELETE ON "migration_sample_evidence_quarantine"
FOR EACH ROW EXECUTE FUNCTION prevent_task13_append_only_mutation();
