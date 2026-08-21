CREATE TABLE "vehicle_reassignment_approval" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "application_id" uuid NOT NULL,
  "previous_assignment_id" uuid NOT NULL,
  "requested_vehicle_unit_id" uuid NOT NULL,
  "contract_id" uuid,
  "requested_by" uuid NOT NULL,
  "requested_by_role" text NOT NULL,
  "approved_by" uuid,
  "approved_by_role" text,
  "status" text NOT NULL DEFAULT 'PENDING',
  "reason" text NOT NULL,
  "effective_from" timestamp with time zone NOT NULL,
  "effective_until" timestamp with time zone,
  "approved_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "vehicle_reassignment_approval_status_allowed" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED')),
  CONSTRAINT "vehicle_reassignment_approval_reason_nonempty" CHECK (length(btrim("reason")) > 0),
  CONSTRAINT "vehicle_reassignment_approval_window_ordered" CHECK ("effective_until" IS NULL OR "effective_until" > "effective_from"),
  CONSTRAINT "vehicle_reassignment_approval_approved_consistent" CHECK (("status" <> 'APPROVED' AND "approved_by" IS NULL AND "approved_at" IS NULL) OR ("status" = 'APPROVED' AND "approved_by" IS NOT NULL AND "approved_by_role" IS NOT NULL AND "approved_at" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "vehicle_reassignment_approval"
  ADD CONSTRAINT "vehicle_reassignment_approval_application_fk"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_reassignment_approval_previous_assignment_fk"
    FOREIGN KEY ("previous_assignment_id") REFERENCES "vehicle_assignment"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_reassignment_approval_requested_vehicle_fk"
    FOREIGN KEY ("requested_vehicle_unit_id") REFERENCES "vehicle_unit"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_reassignment_approval_contract_fk"
    FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_reassignment_approval_requested_by_fk"
    FOREIGN KEY ("requested_by") REFERENCES "staff_user"("id") ON DELETE restrict,
  ADD CONSTRAINT "vehicle_reassignment_approval_approved_by_fk"
    FOREIGN KEY ("approved_by") REFERENCES "staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_reassignment_approval_active_unique"
  ON "vehicle_reassignment_approval" ("application_id", "previous_assignment_id", "requested_vehicle_unit_id")
  WHERE "status" IN ('PENDING', 'APPROVED');
--> statement-breakpoint
CREATE INDEX "vehicle_reassignment_approval_application_idx"
  ON "vehicle_reassignment_approval" ("application_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE "handover_customer_acknowledgement" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "contract_id" uuid NOT NULL,
  "application_id" uuid NOT NULL,
  "person_id" uuid NOT NULL,
  "customer_account_id" uuid NOT NULL,
  "customer_session_id" uuid NOT NULL,
  "checklist_version" text NOT NULL,
  "checklist_hash" text NOT NULL,
  "acknowledged_at" timestamp with time zone NOT NULL,
  "idempotency_key" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "handover_ack_checklist_hash_sha256" CHECK ("checklist_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "handover_ack_checklist_version_nonempty" CHECK (length(btrim("checklist_version")) > 0)
);
--> statement-breakpoint
ALTER TABLE "handover_customer_acknowledgement"
  ADD CONSTRAINT "handover_ack_contract_fk"
    FOREIGN KEY ("contract_id") REFERENCES "contract"("id") ON DELETE restrict,
  ADD CONSTRAINT "handover_ack_application_fk"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE restrict,
  ADD CONSTRAINT "handover_ack_person_fk"
    FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict,
  ADD CONSTRAINT "handover_ack_customer_account_fk"
    FOREIGN KEY ("customer_account_id") REFERENCES "customer_account"("id") ON DELETE restrict,
  ADD CONSTRAINT "handover_ack_customer_session_fk"
    FOREIGN KEY ("customer_session_id") REFERENCES "customer_session"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "contract_execution"
  ADD COLUMN "head_office_id" text,
  ADD CONSTRAINT "contract_execution_executed_document_fk"
    FOREIGN KEY ("executed_document_id") REFERENCES "privacy"."document"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "handover_record"
  ADD COLUMN "head_office_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "handover_ack_contract_idempotency_unique"
  ON "handover_customer_acknowledgement" ("contract_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "handover_ack_contract_idx"
  ON "handover_customer_acknowledgement" ("contract_id", "acknowledged_at" DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_handover_customer_ack_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'HANDOVER_CUSTOMER_ACK_APPEND_ONLY' USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER handover_customer_ack_append_only
  BEFORE UPDATE OR DELETE ON "handover_customer_acknowledgement"
  FOR EACH ROW EXECUTE FUNCTION reject_handover_customer_ack_mutation();
--> statement-breakpoint
ALTER TABLE "asset_contract_command"
  DROP CONSTRAINT "asset_contract_command_type_allowed";
--> statement-breakpoint
ALTER TABLE "asset_contract_command"
  ADD CONSTRAINT "asset_contract_command_type_allowed" CHECK ("command_type" IN ('VEHICLE_REGISTER', 'VEHICLE_ASSIGN', 'CONTRACT_GENERATE', 'CONTRACT_EXECUTE', 'HANDOVER_COMPLETE', 'CONTRACT_ACTIVATE', 'TRACKER_ACCESS', 'VEHICLE_REGISTRATION', 'VEHICLE_INSURANCE', 'TRACKER_ASSOCIATE', 'HANDOVER_ACKNOWLEDGE', 'REASSIGNMENT_REQUEST', 'REASSIGNMENT_APPROVE'));
