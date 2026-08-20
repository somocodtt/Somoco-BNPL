ALTER TABLE "financing_rule_version"
  ADD COLUMN "selling_price_minor_units" bigint NOT NULL DEFAULT 0,
  ADD COLUMN "permitted_fees" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "eligibility_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "required_evidence" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "exception_policy" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN "disclosure_version" text,
  ADD COLUMN "fixture_hashes" jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "licence_permitted" boolean NOT NULL DEFAULT false,
  ADD COLUMN "requested_by" uuid,
  ADD COLUMN "approved_by" uuid,
  ADD COLUMN "approved_at" timestamp with time zone,
  ADD COLUMN "effective_until" timestamp with time zone,
  ADD COLUMN "published_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "financing_rule_version"
   SET "calculation_method" = 'REDUCING_BALANCE'
 WHERE "calculation_method" = 'DECLINING_BALANCE';
--> statement-breakpoint
ALTER TABLE "financing_rule_version"
  ADD CONSTRAINT "financing_rule_selling_price_nonnegative"
    CHECK ("selling_price_minor_units" >= 0),
  ADD CONSTRAINT "financing_rule_method_allowed"
    CHECK ("calculation_method" in ('FLAT_MARKUP', 'REDUCING_BALANCE')),
  ADD CONSTRAINT "financing_rule_approval_actor_separate"
    CHECK ("requested_by" is null or "approved_by" is null or "requested_by" <> "approved_by"),
  ADD CONSTRAINT "financing_rule_effective_window_ordered"
    CHECK ("effective_until" is null or "effective_from" is null or "effective_until" > "effective_from");
--> statement-breakpoint
ALTER TABLE "financing_rule_version"
  ADD CONSTRAINT "financing_rule_requested_by_staff_user_id_fk"
    FOREIGN KEY ("requested_by") REFERENCES "staff_user"("id") ON DELETE restrict,
  ADD CONSTRAINT "financing_rule_approved_by_staff_user_id_fk"
    FOREIGN KEY ("approved_by") REFERENCES "staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "exception_request"
  ADD COLUMN "required_approver_role" text NOT NULL DEFAULT 'PRODUCT_ADMIN',
  ADD COLUMN "decided_by" uuid,
  ADD COLUMN "decided_at" timestamp with time zone,
  ADD COLUMN "decision_reason" text,
  ADD COLUMN "expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "exception_request"
  ADD CONSTRAINT "exception_request_decision_consistent"
    CHECK ("status" <> 'PENDING' or ("decided_by" is null and "decided_at" is null)),
  ADD CONSTRAINT "exception_request_requester_separate"
    CHECK ("decided_by" is null or "decided_by" <> "requested_by");
--> statement-breakpoint
ALTER TABLE "exception_request"
  ADD CONSTRAINT "exception_request_decided_by_staff_user_id_fk"
    FOREIGN KEY ("decided_by") REFERENCES "staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "offer"
  ADD COLUMN "status" text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "expires_at" timestamp with time zone,
  ADD COLUMN "accepted_by_person_id" uuid,
  ADD COLUMN "accepted_hash" text,
  ADD COLUMN "consent_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "offer"
   SET "status" = 'ACCEPTED'
 WHERE "accepted_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "offer"
  ADD CONSTRAINT "offer_status_allowed"
    CHECK ("status" in ('PENDING', 'EXPIRED', 'ACCEPTED', 'CANCELLED'));
--> statement-breakpoint
ALTER TABLE "offer"
  ADD CONSTRAINT "offer_accepted_by_person_id_person_id_fk"
    FOREIGN KEY ("accepted_by_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "offer_version"
  ADD COLUMN "canonical_hash" text;
--> statement-breakpoint
ALTER TABLE "audit_event"
  ADD COLUMN "actor_person_id" uuid;
--> statement-breakpoint
ALTER TABLE "audit_event"
  ADD CONSTRAINT "audit_event_actor_person_id_person_id_fk"
    FOREIGN KEY ("actor_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE TABLE "exception_decision" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "exception_request_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" text NOT NULL,
  "decided_by" uuid NOT NULL,
  "reason" text NOT NULL,
  "decided_at" timestamp with time zone NOT NULL,
  CONSTRAINT "exception_decision_status_allowed" CHECK ("status" in ('APPROVED', 'REJECTED'))
);
--> statement-breakpoint
ALTER TABLE "exception_decision"
  ADD CONSTRAINT "exception_decision_request_id_exception_request_id_fk"
    FOREIGN KEY ("exception_request_id") REFERENCES "exception_request"("id") ON DELETE restrict,
  ADD CONSTRAINT "exception_decision_decided_by_staff_user_id_fk"
    FOREIGN KEY ("decided_by") REFERENCES "staff_user"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "exception_decision_request_version_unique"
  ON "exception_decision" USING btree ("exception_request_id", "version");
--> statement-breakpoint
CREATE TABLE "financing_command" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "scope" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "command_type" text NOT NULL,
  "payload_hash" text NOT NULL,
  "actor_staff_user_id" uuid,
  "actor_person_id" uuid,
  "application_id" uuid,
  "response" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "financing_command_type_allowed" CHECK ("command_type" in ('PRODUCT_PUBLISH', 'EXCEPTION_REQUEST', 'EXCEPTION_DECIDE', 'OFFER_CREATE', 'OFFER_ACCEPT')),
  CONSTRAINT "financing_command_payload_hash_sha256" CHECK ("payload_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "financing_command_actor_exclusive" CHECK (("actor_staff_user_id" is null) <> ("actor_person_id" is null))
);
--> statement-breakpoint
ALTER TABLE "financing_command"
  ADD CONSTRAINT "financing_command_actor_staff_user_id_staff_user_id_fk"
    FOREIGN KEY ("actor_staff_user_id") REFERENCES "staff_user"("id") ON DELETE restrict,
  ADD CONSTRAINT "financing_command_actor_person_id_person_id_fk"
    FOREIGN KEY ("actor_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict,
  ADD CONSTRAINT "financing_command_application_id_application_id_fk"
    FOREIGN KEY ("application_id") REFERENCES "application"("id") ON DELETE restrict;
--> statement-breakpoint
CREATE UNIQUE INDEX "financing_command_scope_key_unique"
  ON "financing_command" USING btree ("scope", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "financing_command_application_idx"
  ON "financing_command" USING btree ("application_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_published_financing_rule_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved OR OLD.published_at IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLISHED_FINANCING_RULE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER financing_rule_published_immutable
  BEFORE UPDATE OR DELETE ON "financing_rule_version"
  FOR EACH ROW EXECUTE FUNCTION reject_published_financing_rule_mutation();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reject_accepted_offer_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'offer' AND (OLD.status = 'ACCEPTED' OR OLD.accepted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ACCEPTED_OFFER_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  IF TG_TABLE_NAME = 'offer_version' AND EXISTS (
    SELECT 1 FROM offer WHERE id = OLD.offer_id AND (status = 'ACCEPTED' OR accepted_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'ACCEPTED_OFFER_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER offer_accepted_immutable
  BEFORE UPDATE OR DELETE ON "offer"
  FOR EACH ROW EXECUTE FUNCTION reject_accepted_offer_mutation();
CREATE TRIGGER offer_version_accepted_immutable
  BEFORE UPDATE OR DELETE ON "offer_version"
  FOR EACH ROW EXECUTE FUNCTION reject_accepted_offer_mutation();
