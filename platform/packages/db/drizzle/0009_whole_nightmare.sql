CREATE TABLE "staff_delegation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"delegated_staff_user_id" uuid NOT NULL,
	"delegated_role" text NOT NULL,
	"scope" jsonb NOT NULL,
	"approved_by" uuid NOT NULL,
	"approved_at" timestamp with time zone,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_delegation_role_allowed" CHECK ("staff_delegation"."delegated_role" in ('VERIFICATION_OFFICER', 'BSM', 'AGM', 'CFO', 'MD')),
	CONSTRAINT "staff_delegation_status_allowed" CHECK ("staff_delegation"."status" in ('PENDING', 'APPROVED', 'REVOKED', 'EXPIRED')),
	CONSTRAINT "staff_delegation_window_ordered" CHECK ("staff_delegation"."effective_until" > "staff_delegation"."effective_from"),
	CONSTRAINT "staff_delegation_approval_consistent" CHECK (("staff_delegation"."status" = 'APPROVED') = ("staff_delegation"."approved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "workflow_command" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"idempotency_key" uuid NOT NULL,
	"command_type" text NOT NULL,
	"payload_hash" text NOT NULL,
	"request_id" uuid NOT NULL,
	"actor_staff_user_id" uuid,
	"actor_person_id" uuid,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_command_type_allowed" CHECK ("workflow_command"."command_type" in ('APPROVAL', 'RESUBMISSION', 'MANUAL_CREDIT_BUREAU')),
	CONSTRAINT "workflow_command_payload_hash_sha256" CHECK ("workflow_command"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "workflow_command_actor_exclusive" CHECK (("workflow_command"."actor_staff_user_id" is null) <> ("workflow_command"."actor_person_id" is null))
);
--> statement-breakpoint
ALTER TABLE "application" ADD COLUMN "information_requested_stage" "approval_stage";--> statement-breakpoint
ALTER TABLE "staff_delegation" ADD CONSTRAINT "staff_delegation_delegated_staff_user_id_staff_user_id_fk" FOREIGN KEY ("delegated_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_delegation" ADD CONSTRAINT "staff_delegation_approved_by_staff_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_command" ADD CONSTRAINT "workflow_command_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_command" ADD CONSTRAINT "workflow_command_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_command" ADD CONSTRAINT "workflow_command_actor_person_id_person_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "staff_delegation_delegate_idx" ON "staff_delegation" USING btree ("delegated_staff_user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_command_application_key_unique" ON "workflow_command" USING btree ("application_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "workflow_command_application_idx" ON "workflow_command" USING btree ("application_id");