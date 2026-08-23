ALTER TABLE "migration_sample_evidence"
  DROP CONSTRAINT "migration_sample_evidence_migration_record_id_migration_record_id_fk";
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence"
  ADD COLUMN "verification_command_id" uuid;
--> statement-breakpoint
CREATE UNIQUE INDEX "migration_record_batch_id_id_unique"
  ON "migration_record" USING btree ("migration_batch_id", "id");
--> statement-breakpoint
ALTER TABLE "migration_sample_evidence"
  ADD CONSTRAINT "migration_sample_evidence_batch_record_fk"
  FOREIGN KEY ("migration_batch_id", "migration_record_id")
  REFERENCES "public"."migration_record"("migration_batch_id", "id")
  ON DELETE restrict ON UPDATE no action;
