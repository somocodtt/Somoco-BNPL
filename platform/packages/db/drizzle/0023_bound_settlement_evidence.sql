ALTER TABLE "settlement_evidence" DROP CONSTRAINT "settlement_evidence_status_allowed";--> statement-breakpoint
ALTER TABLE "settlement_evidence" DISABLE TRIGGER "settlement_evidence_append_only";--> statement-breakpoint
UPDATE "settlement_evidence"
   SET "verification_status" = 'REVOKED'
 WHERE "verification_status" = 'CLEAN'
   AND ("evidence_document_id" is null
     OR "evidence_object_key" is null
     OR length(btrim("evidence_object_key")) = 0
     OR "evidence_object_version_id" is null
     OR length(btrim("evidence_object_version_id")) = 0
     OR "evidence_object_etag" is null
     OR length(btrim("evidence_object_etag")) = 0);--> statement-breakpoint
ALTER TABLE "settlement_evidence" ENABLE TRIGGER "settlement_evidence_append_only";--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD CONSTRAINT "settlement_evidence_status_allowed" CHECK ("settlement_evidence"."verification_status" in ('CLEAN', 'REVOKED'));--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD CONSTRAINT "settlement_evidence_clean_binding_complete" CHECK ("settlement_evidence"."verification_status" <> 'CLEAN' or (
        "settlement_evidence"."evidence_document_id" is not null
        and "settlement_evidence"."evidence_object_key" is not null
        and length(btrim("settlement_evidence"."evidence_object_key")) > 0
        and "settlement_evidence"."evidence_object_version_id" is not null
        and length(btrim("settlement_evidence"."evidence_object_version_id")) > 0
        and "settlement_evidence"."evidence_object_etag" is not null
        and length(btrim("settlement_evidence"."evidence_object_etag")) > 0
      ));
