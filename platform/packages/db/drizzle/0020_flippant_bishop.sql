CREATE TABLE "arrears_escalation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"signal" text NOT NULL,
	"overdue_minor_units" bigint NOT NULL,
	"unpaid_installments" integer NOT NULL,
	"consecutive_missed_installments" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arrears_escalation_signal_allowed" CHECK ("arrears_escalation"."signal" in ('THREE_CONSECUTIVE_MISSED', 'THREE_TOTAL_UNPAID')),
	CONSTRAINT "arrears_escalation_overdue_nonnegative" CHECK ("arrears_escalation"."overdue_minor_units" >= 0),
	CONSTRAINT "arrears_escalation_counts_nonnegative" CHECK ("arrears_escalation"."unpaid_installments" >= 0 and "arrears_escalation"."consecutive_missed_installments" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_action" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recovery_case_id" uuid NOT NULL,
	"action_type" text NOT NULL,
	"purpose" text NOT NULL,
	"requested_by" uuid NOT NULL,
	"authorized_by" uuid NOT NULL,
	"evidence_hash" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_action_type_allowed" CHECK ("recovery_action"."action_type" in ('MANUAL_RECOVERY', 'SEIZURE_EVIDENCE', 'VISIT', 'PROMISE_TO_PAY')),
	CONSTRAINT "recovery_action_maker_checker_distinct" CHECK ("recovery_action"."requested_by" <> "recovery_action"."authorized_by"),
	CONSTRAINT "recovery_action_purpose_nonempty" CHECK (length(btrim("recovery_action"."purpose")) > 0),
	CONSTRAINT "recovery_action_evidence_hash_sha256" CHECK ("recovery_action"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "recovery_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recovery_case_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"maker_staff_user_id" uuid NOT NULL,
	"checker_staff_user_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"purpose" text NOT NULL,
	"reason" text NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recovery_decision_allowed" CHECK ("recovery_decision"."decision" in ('APPROVED', 'DENIED')),
	CONSTRAINT "recovery_decision_maker_checker_distinct" CHECK ("recovery_decision"."maker_staff_user_id" <> "recovery_decision"."checker_staff_user_id"),
	CONSTRAINT "recovery_decision_text_nonempty" CHECK (length(btrim("recovery_decision"."purpose")) > 0 and length(btrim("recovery_decision"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_location_lookup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recovery_case_id" uuid NOT NULL,
	"actor_staff_user_id" uuid NOT NULL,
	"tracker_id" text NOT NULL,
	"purpose" text NOT NULL,
	"latitude" text,
	"longitude" text,
	"recorded_at" timestamp with time zone,
	"device_status" text,
	"accessed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "recovery_location_lookup_purpose_nonempty" CHECK (length(btrim("recovery_location_lookup"."purpose")) > 0),
	CONSTRAINT "recovery_location_lookup_status_allowed" CHECK ("recovery_location_lookup"."device_status" is null or "recovery_location_lookup"."device_status" in ('ONLINE', 'OFFLINE', 'UNKNOWN'))
);
--> statement-breakpoint
CREATE TABLE "settlement_approval" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"approval_type" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"approved_by" uuid NOT NULL,
	"reason" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_approval_type_allowed" CHECK ("settlement_approval"."approval_type" in ('FINANCE_RECONCILIATION', 'BUSINESS_OWNERSHIP_TRANSFER')),
	CONSTRAINT "settlement_approval_reason_nonempty" CHECK (length(btrim("settlement_approval"."reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "settlement_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"evidence_document_reference" text NOT NULL,
	"evidence_hash" text NOT NULL,
	"verification_status" text NOT NULL,
	"accepted_by" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_evidence_status_allowed" CHECK ("settlement_evidence"."verification_status" = 'CLEAN'),
	CONSTRAINT "settlement_evidence_document_nonempty" CHECK (length(btrim("settlement_evidence"."evidence_document_reference")) > 0),
	CONSTRAINT "settlement_evidence_hash_sha256" CHECK ("settlement_evidence"."evidence_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "settlement_workflow" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"finance_approval_id" uuid,
	"business_approval_id" uuid,
	"evidence_id" uuid,
	"settled_at" timestamp with time zone,
	"transferred_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settlement_workflow_status_allowed" CHECK ("settlement_workflow"."status" in ('PENDING', 'SETTLED', 'TRANSFERRED', 'REJECTED')),
	CONSTRAINT "settlement_workflow_version_positive" CHECK ("settlement_workflow"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "arrears_escalation" ADD CONSTRAINT "arrears_escalation_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_action" ADD CONSTRAINT "recovery_action_recovery_case_id_recovery_case_id_fk" FOREIGN KEY ("recovery_case_id") REFERENCES "public"."recovery_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_action" ADD CONSTRAINT "recovery_action_requested_by_staff_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_action" ADD CONSTRAINT "recovery_action_authorized_by_staff_user_id_fk" FOREIGN KEY ("authorized_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_decision" ADD CONSTRAINT "recovery_decision_recovery_case_id_recovery_case_id_fk" FOREIGN KEY ("recovery_case_id") REFERENCES "public"."recovery_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_decision" ADD CONSTRAINT "recovery_decision_maker_staff_user_id_staff_user_id_fk" FOREIGN KEY ("maker_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_decision" ADD CONSTRAINT "recovery_decision_checker_staff_user_id_staff_user_id_fk" FOREIGN KEY ("checker_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_location_lookup" ADD CONSTRAINT "recovery_location_lookup_recovery_case_id_recovery_case_id_fk" FOREIGN KEY ("recovery_case_id") REFERENCES "public"."recovery_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_location_lookup" ADD CONSTRAINT "recovery_location_lookup_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD CONSTRAINT "settlement_approval_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_approval" ADD CONSTRAINT "settlement_approval_approved_by_staff_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD CONSTRAINT "settlement_evidence_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_evidence" ADD CONSTRAINT "settlement_evidence_accepted_by_staff_user_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_workflow" ADD CONSTRAINT "settlement_workflow_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_workflow" ADD CONSTRAINT "settlement_workflow_finance_approval_id_settlement_approval_id_fk" FOREIGN KEY ("finance_approval_id") REFERENCES "public"."settlement_approval"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_workflow" ADD CONSTRAINT "settlement_workflow_business_approval_id_settlement_approval_id_fk" FOREIGN KEY ("business_approval_id") REFERENCES "public"."settlement_approval"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settlement_workflow" ADD CONSTRAINT "settlement_workflow_evidence_id_settlement_evidence_id_fk" FOREIGN KEY ("evidence_id") REFERENCES "public"."settlement_evidence"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "arrears_escalation_contract_date_signal_unique" ON "arrears_escalation" USING btree ("contract_id","as_of_date","signal");--> statement-breakpoint
CREATE INDEX "arrears_escalation_contract_idx" ON "arrears_escalation" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "recovery_action_case_idx" ON "recovery_action" USING btree ("recovery_case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_decision_idempotency_unique" ON "recovery_decision" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "recovery_decision_case_idx" ON "recovery_decision" USING btree ("recovery_case_id");--> statement-breakpoint
CREATE INDEX "recovery_location_lookup_case_idx" ON "recovery_location_lookup" USING btree ("recovery_case_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_approval_idempotency_unique" ON "settlement_approval" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_approval_contract_type_unique" ON "settlement_approval" USING btree ("contract_id","approval_type");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_evidence_contract_unique" ON "settlement_evidence" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "settlement_workflow_contract_unique" ON "settlement_workflow" USING btree ("contract_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_task12_append_only_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'task 12 evidence is append-only' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER arrears_escalation_append_only
BEFORE UPDATE OR DELETE ON arrears_escalation
FOR EACH ROW EXECUTE FUNCTION prevent_task12_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER recovery_decision_append_only
BEFORE UPDATE OR DELETE ON recovery_decision
FOR EACH ROW EXECUTE FUNCTION prevent_task12_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER recovery_action_append_only
BEFORE UPDATE OR DELETE ON recovery_action
FOR EACH ROW EXECUTE FUNCTION prevent_task12_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER recovery_location_lookup_append_only
BEFORE UPDATE OR DELETE ON recovery_location_lookup
FOR EACH ROW EXECUTE FUNCTION prevent_task12_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER settlement_approval_append_only
BEFORE UPDATE OR DELETE ON settlement_approval
FOR EACH ROW EXECUTE FUNCTION prevent_task12_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER settlement_evidence_append_only
BEFORE UPDATE OR DELETE ON settlement_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_task12_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER delivery_attempt_append_only
BEFORE UPDATE OR DELETE ON delivery_attempt
FOR EACH ROW EXECUTE FUNCTION prevent_task12_append_only_mutation();--> statement-breakpoint
CREATE UNIQUE INDEX outbox_contract_settlement_event_once
ON outbox_message (topic, aggregate_id)
WHERE topic in ('ContractSettled', 'OwnershipTransferred');--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'somo_runtime') THEN
    CREATE ROLE somo_runtime NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE arrears_escalation, recovery_decision, recovery_action, recovery_location_lookup, settlement_approval, settlement_evidence, settlement_workflow TO somo_runtime;--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE arrears_escalation, recovery_decision, recovery_action, recovery_location_lookup, settlement_approval, settlement_evidence FROM somo_runtime;
