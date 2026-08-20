CREATE TABLE "application_mutation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"actor_person_id" uuid NOT NULL,
	"mutation_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_mutation_operation_safe" CHECK ("application_mutation"."operation" ~ '^[A-Z][A-Z0-9_]{1,63}$'),
	CONSTRAINT "application_mutation_payload_hash_sha256" CHECK ("application_mutation"."payload_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "guarantor_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"guarantor_person_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_by_person_id" uuid,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guarantor_invitation_token_hash_sha256" CHECK ("guarantor_invitation"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "guarantor_invitation_expiry_after_creation" CHECK ("guarantor_invitation"."expires_at" > "guarantor_invitation"."created_at"),
	CONSTRAINT "guarantor_invitation_claim_consistent" CHECK (("guarantor_invitation"."claimed_at" is null) = ("guarantor_invitation"."claimed_by_person_id" is null)),
	CONSTRAINT "guarantor_invitation_claim_target_matches" CHECK ("guarantor_invitation"."claimed_by_person_id" is null or "guarantor_invitation"."claimed_by_person_id" = "guarantor_invitation"."guarantor_person_id"),
	CONSTRAINT "guarantor_invitation_terminal_state_exclusive" CHECK (not ("guarantor_invitation"."claimed_at" is not null and "guarantor_invitation"."revoked_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "application_mutation" ADD CONSTRAINT "application_mutation_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_mutation" ADD CONSTRAINT "application_mutation_actor_person_id_person_id_fk" FOREIGN KEY ("actor_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantor_invitation" ADD CONSTRAINT "guarantor_invitation_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantor_invitation" ADD CONSTRAINT "guarantor_invitation_guarantor_person_id_person_id_fk" FOREIGN KEY ("guarantor_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantor_invitation" ADD CONSTRAINT "guarantor_invitation_claimed_by_person_id_person_id_fk" FOREIGN KEY ("claimed_by_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "application_mutation_actor_idempotency_unique" ON "application_mutation" USING btree ("actor_person_id","mutation_id");--> statement-breakpoint
CREATE INDEX "application_mutation_application_idx" ON "application_mutation" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guarantor_invitation_token_hash_unique" ON "guarantor_invitation" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "guarantor_invitation_application_active_unique" ON "guarantor_invitation" USING btree ("application_id") WHERE "guarantor_invitation"."claimed_at" is null and "guarantor_invitation"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "guarantor_invitation_guarantor_idx" ON "guarantor_invitation" USING btree ("guarantor_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guarantor_relationship_application_unique" ON "guarantor_relationship" USING btree ("application_id");--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_application_version_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'submitted application versions are immutable' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER application_version_immutable
BEFORE UPDATE OR DELETE ON "application_version"
FOR EACH ROW EXECUTE FUNCTION prevent_application_version_mutation();
