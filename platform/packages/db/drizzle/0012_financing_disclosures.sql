ALTER TABLE "financing_rule_version"
  ADD COLUMN "disclosure_content" jsonb,
  ADD COLUMN "disclosure_hash" text;
--> statement-breakpoint
ALTER TABLE "exception_request"
  ADD CONSTRAINT "exception_request_value_type_allowed"
    CHECK ("value_type" IS NULL OR "value_type" IN ('AMOUNT', 'FREQUENCY', 'TENURE'));
