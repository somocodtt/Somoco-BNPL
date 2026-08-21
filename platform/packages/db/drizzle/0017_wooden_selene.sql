CREATE TABLE "payment_allocation_policy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"policy_hash" text NOT NULL,
	"worked_example_hash" text NOT NULL,
	"worked_example" jsonb NOT NULL,
	"finance_approved_by" text NOT NULL,
	"compliance_approved_by" text NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'APPROVED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_allocation_policy_version_nonempty" CHECK (length(btrim("payment_allocation_policy"."version")) > 0),
	CONSTRAINT "payment_allocation_policy_hash_sha256" CHECK ("payment_allocation_policy"."policy_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payment_allocation_policy_worked_hash_sha256" CHECK ("payment_allocation_policy"."worked_example_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "payment_allocation_policy_approvers_distinct" CHECK (length(btrim("payment_allocation_policy"."finance_approved_by")) > 0 and length(btrim("payment_allocation_policy"."compliance_approved_by")) > 0 and "payment_allocation_policy"."finance_approved_by" <> "payment_allocation_policy"."compliance_approved_by"),
	CONSTRAINT "payment_allocation_policy_status_allowed" CHECK ("payment_allocation_policy"."status" in ('APPROVED', 'REVOKED'))
);
--> statement-breakpoint
ALTER TABLE "reconciliation_case" ADD COLUMN "dedupe_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_allocation_policy_version_unique" ON "payment_allocation_policy" USING btree ("version");--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_reverses_entry_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."ledger_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reconciliation_case_dedupe_key_unique" ON "reconciliation_case" USING btree ("dedupe_key") WHERE "reconciliation_case"."dedupe_key" is not null;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_reversal_link_consistent" CHECK (("ledger_entry"."entry_type" in ('REVERSAL', 'REFUND') and "ledger_entry"."reverses_entry_id" is not null) or ("ledger_entry"."entry_type" not in ('REVERSAL', 'REFUND') and "ledger_entry"."reverses_entry_id" is null));