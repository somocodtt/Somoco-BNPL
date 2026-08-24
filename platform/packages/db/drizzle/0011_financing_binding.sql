ALTER TABLE "offer"
  ADD COLUMN "disclosed_version" text,
  ADD COLUMN "disclosed_hash" text;
--> statement-breakpoint
ALTER TABLE "exception_request"
  ADD COLUMN "rule_version_id" uuid,
  ADD COLUMN "exception_field" text,
  ADD COLUMN "value_type" text,
  ADD COLUMN "proposed_amount_minor" bigint,
  ADD COLUMN "policy_amount_minor" bigint,
  ADD COLUMN "proposed_frequency" text,
  ADD COLUMN "policy_frequency" text,
  ADD COLUMN "proposed_tenure_months" integer,
  ADD COLUMN "policy_tenure_months" integer;
--> statement-breakpoint
ALTER TABLE "exception_request"
  ADD CONSTRAINT "exception_request_rule_version_id_financing_rule_version_id_fk"
    FOREIGN KEY ("rule_version_id") REFERENCES "financing_rule_version"("id") ON DELETE restrict;
--> statement-breakpoint
ALTER TABLE "financing_rule_version"
  ADD CONSTRAINT "financing_rule_rate_bps_upper_bound"
    CHECK ("annual_rate_bps" <= 1000000);
--> statement-breakpoint
CREATE INDEX "exception_request_rule_binding_idx"
  ON "exception_request" USING btree ("application_id", "rule_version_id", "exception_field", "status");
