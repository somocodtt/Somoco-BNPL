ALTER TABLE "recovery_action" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "recovery_action" ADD COLUMN "payload_hash" text;--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD COLUMN "evidence_document_id" uuid;--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD COLUMN "evidence_object_key" text;--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD COLUMN "evidence_object_version_id" text;--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD COLUMN "evidence_object_etag" text;--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD CONSTRAINT "settlement_evidence_evidence_document_id_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "privacy"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_action_idempotency_unique" ON "recovery_action" USING btree ("idempotency_key") WHERE "recovery_action"."idempotency_key" is not null;--> statement-breakpoint
ALTER TABLE "recovery_action" ADD CONSTRAINT "recovery_action_payload_hash_sha256" CHECK ("recovery_action"."payload_hash" is null or "recovery_action"."payload_hash" ~ '^[0-9a-f]{64}$');