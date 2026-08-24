ALTER TYPE "public"."staff_role" ADD VALUE 'COMPLIANCE_OFFICER';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'DPO';--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD COLUMN "contract_version" integer;--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD COLUMN "ledger_head_id" uuid;--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD COLUMN "ledger_digest" text;--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD COLUMN "balance_minor_units" bigint;--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD COLUMN "reconciliation_checkpoint" text;--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD COLUMN "bundle_digest" text;--> statement-breakpoint
ALTER TABLE "settlement_approval" DISABLE TRIGGER "settlement_approval_append_only";--> statement-breakpoint
UPDATE "settlement_approval" approval
   SET "contract_version" = contract.version,
       "ledger_digest" = repeat('0', 64),
       "balance_minor_units" = contract.outstanding_balance_minor_units,
       "reconciliation_checkpoint" = repeat('0', 64),
       "bundle_digest" = repeat('0', 64)
  FROM "contract"
 WHERE contract.id = approval.contract_id;--> statement-breakpoint
ALTER TABLE "settlement_approval" ENABLE TRIGGER "settlement_approval_append_only";--> statement-breakpoint
ALTER TABLE "settlement_approval" ALTER COLUMN "contract_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_approval" ALTER COLUMN "ledger_digest" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_approval" ALTER COLUMN "balance_minor_units" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_approval" ALTER COLUMN "reconciliation_checkpoint" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "settlement_approval" ALTER COLUMN "bundle_digest" SET NOT NULL;--> statement-breakpoint
DROP INDEX "settlement_approval_contract_type_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_approval_contract_type_bundle_unique" ON "settlement_approval" USING btree ("contract_id", "approval_type", "bundle_digest");--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD CONSTRAINT "settlement_approval_snapshot_valid" CHECK (
  "contract_version" > 0
  AND "balance_minor_units" >= 0
  AND "ledger_digest" ~ '^[0-9a-f]{64}$'
  AND "reconciliation_checkpoint" ~ '^[0-9a-f]{64}$'
  AND "bundle_digest" ~ '^[0-9a-f]{64}$'
);--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD COLUMN "original_payment_transaction_id" uuid;--> statement-breakpoint
WITH compensation_candidates AS (
  SELECT compensation.id,
         original.id AS original_id,
         row_number() OVER (
           PARTITION BY original.id
           ORDER BY compensation.created_at, compensation.id
         ) AS lifecycle_rank
    FROM payment_transaction compensation
    JOIN payment_transaction original
      ON original.provider = compensation.provider
     AND original.provider_transaction_id =
         compensation.provider_payload->>'originalProviderTransactionId'
   WHERE compensation.event_type IN ('PAYMENT_REVERSED', 'PAYMENT_REFUNDED')
)
UPDATE payment_transaction payment
   SET original_payment_transaction_id = candidate.original_id
  FROM compensation_candidates candidate
 WHERE payment.id = candidate.id
   AND candidate.lifecycle_rank = 1;--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_original_transaction_fk" FOREIGN KEY ("original_payment_transaction_id") REFERENCES "public"."payment_transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_original_compensation_unique" ON "payment_transaction" USING btree ("original_payment_transaction_id") WHERE "payment_transaction"."original_payment_transaction_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_one_compensation_per_original_unique" ON "ledger_entry" USING btree ("reverses_entry_id") WHERE "ledger_entry"."reverses_entry_id" is not null and "ledger_entry"."metadata"->>'compensationLifecycle' = 'ONE_PER_ORIGINAL_V1';--> statement-breakpoint
ALTER TABLE "reconciliation_case" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
UPDATE reconciliation_case reconciliation
   SET contract_id = payment.contract_id
  FROM payment_transaction payment
 WHERE payment.id = reconciliation.payment_transaction_id
   AND payment.contract_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "reconciliation_case" ADD CONSTRAINT "reconciliation_case_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reconciliation_case_contract_idx" ON "reconciliation_case" USING btree ("contract_id");--> statement-breakpoint
ALTER TABLE "payment_adjustment" DROP CONSTRAINT "payment_adjustment_status_allowed";--> statement-breakpoint
ALTER TABLE "payment_adjustment" ADD CONSTRAINT "payment_adjustment_status_allowed" CHECK ("payment_adjustment"."status" in ('PENDING', 'APPROVED', 'REJECTED', 'QUARANTINED'));--> statement-breakpoint
ALTER TYPE "public"."contract_status" ADD VALUE 'TRANSFERRED';--> statement-breakpoint
ALTER TABLE "contract" DROP CONSTRAINT "contract_ownership_holder_somoco";--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_ownership_holder_coherent" CHECK (
  ((status::text = 'TRANSFERRED' AND ownership_holder = 'CUSTOMER') OR
   (status::text <> 'TRANSFERRED' AND ownership_holder = 'SOMOCO'))
);--> statement-breakpoint
DROP TRIGGER "ownership_transfer_requires_settlement" ON "ownership_transfer";--> statement-breakpoint
DROP TRIGGER "registration_customer_requires_transfer" ON "registration_record";--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_contract_ownership_coherence(target_contract_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  agreement_status text;
  agreement_holder text;
  agreement_balance bigint;
  asset_status text;
  asset_id uuid;
  transfer_status text;
  transfer_evidence jsonb;
  current_registration_owner text;
  current_registration_evidence uuid;
  transition_observed boolean;
BEGIN
  SELECT agreement.status::text,
         agreement.ownership_holder,
         agreement.outstanding_balance_minor_units,
         asset.status::text,
         asset.id
    INTO agreement_status, agreement_holder, agreement_balance,
         asset_status, asset_id
    FROM contract agreement
    JOIN vehicle_unit asset ON asset.id = agreement.vehicle_unit_id
   WHERE agreement.id = target_contract_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT transfer.status, transfer.evidence
    INTO transfer_status, transfer_evidence
    FROM ownership_transfer transfer
   WHERE transfer.contract_id = target_contract_id;

  SELECT registration.registered_owner::text,
         registration.evidence_document_id
    INTO current_registration_owner, current_registration_evidence
    FROM registration_record registration
   WHERE registration.vehicle_unit_id = asset_id
   ORDER BY registration.created_at DESC, registration.id DESC
   LIMIT 1;

  transition_observed :=
       agreement_status = 'TRANSFERRED'
    OR agreement_holder = 'CUSTOMER'
    OR asset_status = 'TRANSFERRED'
    OR transfer_status = 'COMPLETED'
    OR current_registration_owner = 'CUSTOMER';

  IF transition_observed THEN
    IF agreement_status <> 'TRANSFERRED'
       OR agreement_holder <> 'CUSTOMER'
       OR agreement_balance <> 0
       OR asset_status <> 'TRANSFERRED'
       OR transfer_status IS DISTINCT FROM 'COMPLETED'
       OR current_registration_owner IS DISTINCT FROM 'CUSTOMER'
       OR current_registration_evidence IS NULL
       OR transfer_evidence->>'registrationEvidenceDocumentId'
            IS DISTINCT FROM current_registration_evidence::text THEN
      RAISE EXCEPTION 'ownership transition is not coherent across contract, vehicle, registration, and transfer evidence'
        USING ERRCODE = '23514';
    END IF;
  ELSIF agreement_holder <> 'SOMOCO' THEN
    RAISE EXCEPTION 'pre-transfer contract ownership holder must remain Somoco'
      USING ERRCODE = '23514';
  END IF;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_contract_ownership_coherence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_contract_ownership_coherence(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_vehicle_ownership_coherence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_contract_id uuid;
DECLARE target_vehicle_id uuid;
BEGIN
  target_vehicle_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END;
  SELECT id INTO target_contract_id FROM contract WHERE vehicle_unit_id = target_vehicle_id;
  IF target_contract_id IS NOT NULL THEN
    PERFORM assert_contract_ownership_coherence(target_contract_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_registration_ownership_coherence()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_contract_id uuid;
DECLARE target_vehicle_id uuid;
BEGIN
  target_vehicle_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.vehicle_unit_id ELSE NEW.vehicle_unit_id END;
  SELECT id INTO target_contract_id FROM contract WHERE vehicle_unit_id = target_vehicle_id;
  IF target_contract_id IS NOT NULL THEN
    PERFORM assert_contract_ownership_coherence(target_contract_id);
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_transfer_ownership_coherence()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assert_contract_ownership_coherence(
    CASE WHEN TG_OP = 'DELETE' THEN OLD.contract_id ELSE NEW.contract_id END
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "contract_ownership_coherence"
AFTER INSERT OR UPDATE OR DELETE ON "contract"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_contract_ownership_coherence();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "vehicle_ownership_coherence"
AFTER INSERT OR UPDATE OR DELETE ON "vehicle_unit"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_vehicle_ownership_coherence();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "registration_ownership_coherence"
AFTER INSERT OR UPDATE OR DELETE ON "registration_record"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_registration_ownership_coherence();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "transfer_ownership_coherence"
AFTER INSERT OR UPDATE OR DELETE ON "ownership_transfer"
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
EXECUTE FUNCTION enforce_transfer_ownership_coherence();--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN "preservation_message_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox_message" ADD CONSTRAINT "inbox_preservation_message_fk" FOREIGN KEY ("preservation_message_id") REFERENCES "public"."inbox_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inbox_message" ADD CONSTRAINT "inbox_preservation_not_self" CHECK ("preservation_message_id" is null or "preservation_message_id" <> "id");--> statement-breakpoint
CREATE INDEX "inbox_preservation_message_idx" ON "inbox_message" USING btree ("preservation_message_id");--> statement-breakpoint
CREATE TABLE "privacy"."privacy_request_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_id" uuid NOT NULL,
  "subject_type" text NOT NULL,
  "request_type" text NOT NULL,
  "requested_by" uuid NOT NULL,
  "reason" text,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "privacy_request_subject_type_allowed" CHECK ("subject_type" in ('APPLICANT', 'GUARANTOR')),
  CONSTRAINT "privacy_request_type_allowed" CHECK ("request_type" in ('ACCESS', 'CORRECTION', 'RESTRICTION'))
);--> statement-breakpoint
CREATE TABLE "privacy"."privacy_request_event" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "status" text NOT NULL,
  "actor_id" uuid NOT NULL,
  "evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "privacy_request_event_status_allowed" CHECK ("status" in ('OPEN', 'IN_REVIEW', 'COMPLETED', 'REJECTED', 'CLOSED'))
);--> statement-breakpoint
CREATE TABLE "privacy"."privacy_correction_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "subject_id" uuid NOT NULL,
  "field" text NOT NULL,
  "proposed_value" jsonb NOT NULL,
  "reason" text NOT NULL,
  "version" integer NOT NULL,
  "recorded_by" uuid NOT NULL,
  "recorded_at" timestamp with time zone NOT NULL,
  CONSTRAINT "privacy_correction_version_positive" CHECK ("version" > 0)
);--> statement-breakpoint
CREATE TABLE "privacy"."privacy_restriction_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "request_id" uuid NOT NULL,
  "subject_id" uuid NOT NULL,
  "reason" text NOT NULL,
  "requested_by" uuid NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "released_at" timestamp with time zone
);--> statement-breakpoint
CREATE TABLE "privacy"."privacy_legal_hold_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_id" uuid NOT NULL,
  "action" text NOT NULL,
  "reason" text,
  "actor_id" uuid NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "privacy_legal_hold_action_allowed" CHECK ("action" in ('PLACED', 'RELEASED'))
);--> statement-breakpoint
CREATE TABLE "privacy"."privacy_retention_policy_evidence" (
  "version" text PRIMARY KEY NOT NULL,
  "retention_days" integer NOT NULL,
  "approved_by" uuid NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  CONSTRAINT "privacy_retention_days_positive" CHECK ("retention_days" > 0)
);--> statement-breakpoint
CREATE TABLE "privacy"."privacy_subject_retention_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "subject_id" uuid NOT NULL,
  "policy_version" text NOT NULL,
  "action" text NOT NULL,
  "occurred_at" timestamp with time zone NOT NULL,
  CONSTRAINT "privacy_subject_retention_action_allowed" CHECK ("action" = 'ANONYMIZED')
);--> statement-breakpoint
CREATE TABLE "privacy"."privacy_retention_run_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "policy_version" text NOT NULL,
  "actor_id" uuid NOT NULL,
  "as_of" timestamp with time zone NOT NULL,
  "evaluated" integer NOT NULL,
  "anonymized" integer NOT NULL,
  "retained" integer NOT NULL,
  "skipped_legal_hold" integer NOT NULL,
  "immutable_evidence_retained" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "privacy_retention_run_counts_nonnegative" CHECK (
    "evaluated" >= 0 and "anonymized" >= 0 and "retained" >= 0 and
    "skipped_legal_hold" >= 0 and "immutable_evidence_retained" >= 0
  )
);--> statement-breakpoint
ALTER TABLE "privacy"."privacy_request_event" ADD CONSTRAINT "privacy_request_event_request_fk" FOREIGN KEY ("request_id") REFERENCES "privacy"."privacy_request_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."privacy_correction_evidence" ADD CONSTRAINT "privacy_correction_request_fk" FOREIGN KEY ("request_id") REFERENCES "privacy"."privacy_request_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."privacy_restriction_evidence" ADD CONSTRAINT "privacy_restriction_request_fk" FOREIGN KEY ("request_id") REFERENCES "privacy"."privacy_request_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."privacy_subject_retention_evidence" ADD CONSTRAINT "privacy_subject_retention_policy_fk" FOREIGN KEY ("policy_version") REFERENCES "privacy"."privacy_retention_policy_evidence"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."privacy_retention_run_evidence" ADD CONSTRAINT "privacy_retention_run_policy_fk" FOREIGN KEY ("policy_version") REFERENCES "privacy"."privacy_retention_policy_evidence"("version") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "privacy_request_subject_idx" ON "privacy"."privacy_request_evidence" USING btree ("subject_id", "created_at");--> statement-breakpoint
CREATE INDEX "privacy_request_event_request_idx" ON "privacy"."privacy_request_event" USING btree ("request_id", "occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_correction_subject_field_version_unique" ON "privacy"."privacy_correction_evidence" USING btree ("subject_id", "field", "version");--> statement-breakpoint
CREATE INDEX "privacy_correction_request_idx" ON "privacy"."privacy_correction_evidence" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "privacy_restriction_subject_idx" ON "privacy"."privacy_restriction_evidence" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "privacy_legal_hold_subject_idx" ON "privacy"."privacy_legal_hold_evidence" USING btree ("subject_id", "occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "privacy_subject_anonymized_unique" ON "privacy"."privacy_subject_retention_evidence" USING btree ("subject_id") WHERE "action" = 'ANONYMIZED';--> statement-breakpoint
CREATE INDEX "privacy_retention_run_policy_idx" ON "privacy"."privacy_retention_run_evidence" USING btree ("policy_version", "created_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION privacy.reject_privacy_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'privacy lifecycle evidence is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "privacy_request_evidence_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_request_evidence" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER "privacy_request_event_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_request_event" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER "privacy_correction_evidence_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_correction_evidence" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER "privacy_restriction_evidence_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_restriction_evidence" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER "privacy_legal_hold_evidence_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_legal_hold_evidence" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER "privacy_retention_policy_evidence_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_retention_policy_evidence" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER "privacy_subject_retention_evidence_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_subject_retention_evidence" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
CREATE TRIGGER "privacy_retention_run_evidence_append_only" BEFORE UPDATE OR DELETE ON "privacy"."privacy_retention_run_evidence" FOR EACH ROW EXECUTE FUNCTION privacy.reject_privacy_evidence_mutation();--> statement-breakpoint
REVOKE UPDATE, DELETE ON
  "privacy"."privacy_request_evidence",
  "privacy"."privacy_request_event",
  "privacy"."privacy_correction_evidence",
  "privacy"."privacy_restriction_evidence",
  "privacy"."privacy_legal_hold_evidence",
  "privacy"."privacy_retention_policy_evidence",
  "privacy"."privacy_subject_retention_evidence",
  "privacy"."privacy_retention_run_evidence"
FROM somo_runtime;
