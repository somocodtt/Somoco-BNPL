ALTER TABLE "payment_transaction" ADD COLUMN "event_id" text;
--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD COLUMN "event_type" text;
--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD COLUMN "settlement_reference" text;
--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD COLUMN "allocation_policy_version" text;
--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_event_type_allowed" CHECK ("payment_transaction"."event_type" is null or "payment_transaction"."event_type" in ('PAYMENT_SUCCEEDED', 'PAYMENT_REVERSED', 'PAYMENT_REFUNDED'));
--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_policy_version_nonempty" CHECK ("ledger_entry"."allocation_policy_version" is null or length(btrim("ledger_entry"."allocation_policy_version")) > 0);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_event_unique" ON "payment_transaction" USING btree ("provider","event_id") WHERE "payment_transaction"."event_id" is not null;
--> statement-breakpoint
CREATE TABLE "payment_receipt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_transaction_id" uuid NOT NULL,
	"contract_id" uuid,
	"receipt_number" text NOT NULL,
	"payer_reference" text NOT NULL,
	"amount_minor_units" bigint NOT NULL,
	"currency" text DEFAULT 'GHS' NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"secure_path" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_receipt_amount_positive" CHECK ("payment_receipt"."amount_minor_units" > 0),
	CONSTRAINT "payment_receipt_currency_ghs" CHECK ("payment_receipt"."currency" = 'GHS')
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_receipt_transaction_unique" ON "payment_receipt" USING btree ("payment_transaction_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_receipt_number_unique" ON "payment_receipt" USING btree ("receipt_number");
--> statement-breakpoint
ALTER TABLE "payment_receipt" ADD CONSTRAINT "payment_receipt_payment_transaction_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."payment_transaction"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_receipt" ADD CONSTRAINT "payment_receipt_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "payment_adjustment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"maker_staff_user_id" uuid NOT NULL,
	"checker_staff_user_id" uuid,
	"ledger_entry_id" uuid,
	"amount_minor_units" bigint NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"idempotency_key" text NOT NULL,
	"decision_at" timestamp with time zone,
	"decision_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_adjustment_amount_positive" CHECK ("payment_adjustment"."amount_minor_units" > 0),
	CONSTRAINT "payment_adjustment_status_allowed" CHECK ("payment_adjustment"."status" in ('PENDING', 'APPROVED', 'REJECTED')),
	CONSTRAINT "payment_adjustment_checker_separate" CHECK ("payment_adjustment"."checker_staff_user_id" is null or "payment_adjustment"."checker_staff_user_id" <> "payment_adjustment"."maker_staff_user_id"),
	CONSTRAINT "payment_adjustment_decision_consistent" CHECK ("payment_adjustment"."status" = 'PENDING' or ("payment_adjustment"."checker_staff_user_id" is not null and "payment_adjustment"."decision_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_adjustment_idempotency_unique" ON "payment_adjustment" USING btree ("idempotency_key");
--> statement-breakpoint
ALTER TABLE "payment_adjustment" ADD CONSTRAINT "payment_adjustment_contract_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_adjustment" ADD CONSTRAINT "payment_adjustment_maker_fk" FOREIGN KEY ("maker_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_adjustment" ADD CONSTRAINT "payment_adjustment_checker_fk" FOREIGN KEY ("checker_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "payment_adjustment" ADD CONSTRAINT "payment_adjustment_ledger_fk" FOREIGN KEY ("ledger_entry_id") REFERENCES "public"."ledger_entry"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE TABLE "payment_settlement_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"settlement_reference" text NOT NULL,
	"settlement_currency" text DEFAULT 'GHS' NOT NULL,
	"provider_total_minor_units" bigint NOT NULL,
	"ledger_total_minor_units" bigint NOT NULL,
	"variance_minor_units" bigint NOT NULL,
	"status" text NOT NULL,
	"reconciliation_case_id" uuid,
	"received_at" timestamp with time zone NOT NULL,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_settlement_provider_total_nonnegative" CHECK ("payment_settlement_batch"."provider_total_minor_units" >= 0),
	CONSTRAINT "payment_settlement_ledger_total_nonnegative" CHECK ("payment_settlement_batch"."ledger_total_minor_units" >= 0),
	CONSTRAINT "payment_settlement_currency_ghs" CHECK ("payment_settlement_batch"."settlement_currency" = 'GHS'),
	CONSTRAINT "payment_settlement_status_allowed" CHECK ("payment_settlement_batch"."status" in ('MATCHED', 'VARIANCE', 'PENDING'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "payment_settlement_provider_reference_unique" ON "payment_settlement_batch" USING btree ("provider","settlement_reference");
--> statement-breakpoint
ALTER TABLE "payment_settlement_batch" ADD CONSTRAINT "payment_settlement_case_fk" FOREIGN KEY ("reconciliation_case_id") REFERENCES "public"."reconciliation_case"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'somo_runtime') THEN
    CREATE ROLE somo_runtime NOLOGIN;
  END IF;
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "payment_receipt", "payment_adjustment", "payment_settlement_batch" TO somo_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION prevent_payment_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'payment financial history is append-only'
    USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER payment_receipt_append_only
BEFORE UPDATE OR DELETE ON "payment_receipt"
FOR EACH ROW EXECUTE FUNCTION prevent_payment_financial_mutation();
--> statement-breakpoint
CREATE TRIGGER payment_settlement_batch_append_only
BEFORE UPDATE OR DELETE ON "payment_settlement_batch"
FOR EACH ROW EXECUTE FUNCTION prevent_payment_financial_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "payment_receipt", "payment_settlement_batch" FROM somo_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO somo_runtime;
