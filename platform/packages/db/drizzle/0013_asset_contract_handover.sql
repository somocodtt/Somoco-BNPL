ALTER TABLE "vehicle_unit"
  ADD COLUMN "engine_motor_identifier" text,
  ADD COLUMN "condition" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "accessories" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "tracker_identifier" text;
--> statement-breakpoint
ALTER TABLE "vehicle_unit"
  ADD CONSTRAINT "vehicle_unit_vin_nonempty"
    CHECK (length(btrim("vin")) > 0),
  ADD CONSTRAINT "vehicle_unit_chassis_nonempty"
    CHECK (length(btrim("chassis_number")) > 0),
  ADD CONSTRAINT "vehicle_unit_engine_identifier_present"
    CHECK ("engine_motor_identifier" IS NULL OR length(btrim("engine_motor_identifier")) > 0);
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_unit_tracker_identifier_unique"
  ON "vehicle_unit" USING btree ("tracker_identifier")
  WHERE "tracker_identifier" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "vehicle_assignment"
  ADD COLUMN "offer_id" uuid,
  ADD COLUMN "offer_version_id" uuid,
  ADD COLUMN "deposit_reconciled_amount_minor_units" bigint,
  ADD COLUMN "deposit_evidence_id" uuid,
  ADD COLUMN "supersedes_assignment_id" uuid,
  ADD COLUMN "reassignment_approved_by" uuid,
  ADD COLUMN "reassignment_reason" text,
  ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "vehicle_assignment"
  ADD CONSTRAINT "vehicle_assignment_offer_id_offer_id_fk"
    FOREIGN KEY ("offer_id") REFERENCES "offer"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_assignment_offer_version_id_offer_version_id_fk"
    FOREIGN KEY ("offer_version_id") REFERENCES "offer_version"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_assignment_reassignment_approved_by_staff_user_id_fk"
    FOREIGN KEY ("reassignment_approved_by") REFERENCES "staff_user"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_assignment_version_positive"
    CHECK ("version" > 0),
  ADD CONSTRAINT "vehicle_assignment_reassignment_consistent"
    CHECK (("supersedes_assignment_id" IS NULL AND "reassignment_approved_by" IS NULL AND "reassignment_reason" IS NULL)
       OR ("supersedes_assignment_id" IS NOT NULL AND "reassignment_approved_by" IS NOT NULL AND length(btrim("reassignment_reason")) > 0));
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_assignment_active_application_unique"
  ON "vehicle_assignment" USING btree ("application_id")
  WHERE "released_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "contract"
  ADD COLUMN "template_version_id" uuid,
  ADD COLUMN "canonical_hash" text,
  ADD COLUMN "preview_reference" text,
  ADD COLUMN "ownership_holder" text NOT NULL DEFAULT 'SOMOCO',
  ADD COLUMN "generated_at" timestamp with time zone;
--> statement-breakpoint
CREATE TABLE "contract_template_version" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "template_key" text NOT NULL,
  "version_number" integer NOT NULL,
  "content_hash" text NOT NULL,
  "approved_pdf_hash" text NOT NULL,
  "approved_by" uuid NOT NULL,
  "approved_at" timestamp with time zone NOT NULL,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_until" timestamp with time zone,
  "published_at" timestamp with time zone NOT NULL,
  "attestation_mode" text NOT NULL DEFAULT 'PRODUCTION',
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contract_template_content_hash_sha256" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contract_template_pdf_hash_sha256" CHECK ("approved_pdf_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contract_template_version_positive" CHECK ("version_number" > 0),
  CONSTRAINT "contract_template_window_ordered" CHECK ("effective_until" IS NULL OR "effective_until" > "effective_from"),
  CONSTRAINT "contract_template_attestation_mode_allowed" CHECK ("attestation_mode" IN ('PRODUCTION', 'TEST'))
);
--> statement-breakpoint
ALTER TABLE "contract_template_version"
  ADD CONSTRAINT "contract_template_approved_by_staff_user_id_fk"
    FOREIGN KEY ("approved_by") REFERENCES "staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "contract"
  ADD CONSTRAINT "contract_template_version_id_contract_template_version_id_fk"
    FOREIGN KEY ("template_version_id") REFERENCES "contract_template_version"("id") ON DELETE restrict,
  ADD CONSTRAINT "contract_ownership_holder_somoco"
    CHECK ("ownership_holder" = 'SOMOCO'),
  ADD CONSTRAINT "contract_canonical_hash_sha256"
    CHECK ("canonical_hash" IS NULL OR "canonical_hash" ~ '^[0-9a-f]{64}$');
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_template_key_version_unique"
  ON "contract_template_version" USING btree ("template_key", "version_number");
--> statement-breakpoint
CREATE TABLE "contract_execution" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contract_id" uuid NOT NULL,
  "version_number" integer NOT NULL,
  "applicant_signature" text NOT NULL,
  "guarantor_signature" text NOT NULL,
  "staff_witness_id" uuid NOT NULL,
  "execution_date" timestamp with time zone NOT NULL,
  "head_office_location" text NOT NULL,
  "executed_document_id" uuid NOT NULL,
  "executed_document_hash" text NOT NULL,
  "authorization_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "contract_execution_version_positive" CHECK ("version_number" > 0),
  CONSTRAINT "contract_execution_document_hash_sha256" CHECK ("executed_document_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "contract_execution_signatures_nonempty" CHECK (length(btrim("applicant_signature")) > 0 AND length(btrim("guarantor_signature")) > 0)
);
--> statement-breakpoint
ALTER TABLE "contract_execution"
  ADD CONSTRAINT "contract_execution_contract_id_contract_id_fk"
    FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE restrict,
  ADD CONSTRAINT "contract_execution_staff_witness_id_staff_user_id_fk"
    FOREIGN KEY ("staff_witness_id") REFERENCES "staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "contract_execution_contract_version_unique"
  ON "contract_execution" USING btree ("contract_id", "version_number");
--> statement-breakpoint
ALTER TABLE "handover_record"
  ADD COLUMN "checklist_version" text NOT NULL DEFAULT 'v1',
  ADD COLUMN "customer_acknowledged_at" timestamp with time zone,
  ADD COLUMN "customer_acknowledged_by_person_id" uuid,
  ADD COLUMN "condition" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "accessories" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "head_office_location" text NOT NULL DEFAULT 'Somoco head office',
  ADD COLUMN "version" integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE "handover_record"
  ADD CONSTRAINT "handover_customer_ack_person_id_person_id_fk"
    FOREIGN KEY ("customer_acknowledged_by_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict,
  ADD CONSTRAINT "handover_version_positive" CHECK ("version" > 0);
--> statement-breakpoint
CREATE TABLE "deposit_reconciliation" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "application_id" uuid NOT NULL,
  "offer_id" uuid NOT NULL,
  "payment_transaction_id" uuid,
  "amount_minor_units" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'GHS',
  "status" text NOT NULL,
  "reconciled_at" timestamp with time zone,
  "reconciled_by" uuid,
  "evidence_hash" text NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "deposit_reconciliation_amount_positive" CHECK ("amount_minor_units" > 0),
  CONSTRAINT "deposit_reconciliation_currency_ghs" CHECK ("currency" = 'GHS'),
  CONSTRAINT "deposit_reconciliation_status_allowed" CHECK ("status" IN ('PENDING', 'RECONCILED', 'REJECTED')),
  CONSTRAINT "deposit_reconciliation_reconciled_evidence" CHECK ("status" <> 'RECONCILED' OR ("reconciled_at" IS NOT NULL AND "evidence_hash" ~ '^[0-9a-f]{64}$')),
  CONSTRAINT "deposit_reconciliation_version_positive" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "deposit_reconciliation"
  ADD CONSTRAINT "deposit_reconciliation_application_id_application_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE restrict,
  ADD CONSTRAINT "deposit_reconciliation_offer_id_offer_id_fk"
    FOREIGN KEY ("offer_id") REFERENCES "offer"("id") ON DELETE restrict,
  ADD CONSTRAINT "deposit_reconciliation_payment_transaction_id_payment_transaction_id_fk"
    FOREIGN KEY ("payment_transaction_id") REFERENCES "payment_transaction"("id") ON DELETE restrict,
  ADD CONSTRAINT "deposit_reconciliation_reconciled_by_staff_user_id_fk"
    FOREIGN KEY ("reconciled_by") REFERENCES "staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "deposit_reconciliation_application_offer_unique"
  ON "deposit_reconciliation" USING btree ("application_id", "offer_id");
--> statement-breakpoint
CREATE TABLE "asset_contract_command" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "command_type" text NOT NULL,
  "payload_hash" text NOT NULL,
  "actor_staff_user_id" uuid,
  "actor_person_id" uuid,
  "application_id" uuid,
  "contract_id" uuid,
  "response" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "asset_contract_command_payload_hash_sha256" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "asset_contract_command_actor_exclusive" CHECK (("actor_staff_user_id" IS NOT NULL) <> ("actor_person_id" IS NOT NULL)),
  CONSTRAINT "asset_contract_command_type_allowed" CHECK ("command_type" IN ('VEHICLE_REGISTER', 'VEHICLE_ASSIGN', 'CONTRACT_GENERATE', 'CONTRACT_EXECUTE', 'HANDOVER_COMPLETE', 'CONTRACT_ACTIVATE', 'TRACKER_ACCESS'))
);
--> statement-breakpoint
ALTER TABLE "asset_contract_command"
  ADD CONSTRAINT "asset_contract_command_actor_staff_user_id_staff_user_id_fk"
    FOREIGN KEY ("actor_staff_user_id") REFERENCES "staff_user"("id") ON DELETE restrict,
  ADD CONSTRAINT "asset_contract_command_application_id_application_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE restrict,
  ADD CONSTRAINT "asset_contract_command_contract_id_contract_id_fk"
    FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "asset_contract_command_scope_key_unique"
  ON "asset_contract_command" USING btree ("scope", "idempotency_key");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_contract_execution_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CONTRACT_EXECUTION_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contract_execution_append_only
  BEFORE UPDATE OR DELETE ON "contract_execution"
  FOR EACH ROW EXECUTE FUNCTION reject_contract_execution_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_contract_template_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'CONTRACT_TEMPLATE_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER contract_template_append_only
  BEFORE UPDATE OR DELETE ON "contract_template_version"
  FOR EACH ROW EXECUTE FUNCTION reject_contract_template_mutation();
