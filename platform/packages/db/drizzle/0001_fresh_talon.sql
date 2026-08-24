CREATE TYPE "public"."registration_owner" AS ENUM('SOMOCO', 'CUSTOMER');--> statement-breakpoint
CREATE TYPE "public"."payment_channel" AS ENUM('USSD', 'MOBILE_MONEY');--> statement-breakpoint
CREATE TYPE "public"."payment_provider" AS ENUM('SOMOCO_PAYMENTS');--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM registration_record
    WHERE registered_owner NOT IN ('SOMOCO', 'CUSTOMER')
  ) THEN
    RAISE EXCEPTION 'legacy registration owner is incompatible with registration_owner'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_transaction
    WHERE provider <> 'SOMOCO_PAYMENTS'
  ) THEN
    RAISE EXCEPTION 'legacy payment provider is incompatible with payment_provider'
      USING ERRCODE = '23514';
  END IF;

  IF EXISTS (
    SELECT 1 FROM payment_transaction
    WHERE provider_payload->>'channel' IS NULL
       OR provider_payload->>'channel' NOT IN ('USSD', 'MOBILE_MONEY')
  ) THEN
    RAISE EXCEPTION 'legacy payment channel is missing or incompatible'
      USING ERRCODE = '23514';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "installment" DROP CONSTRAINT "installment_repayment_schedule_id_repayment_schedule_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_payment_transaction_id_payment_transaction_id_fk";
--> statement-breakpoint
ALTER TABLE "ledger_entry" DROP CONSTRAINT "ledger_entry_installment_id_installment_id_fk";
--> statement-breakpoint
ALTER TABLE "registration_record" ALTER COLUMN "registered_owner" SET DEFAULT 'SOMOCO'::"public"."registration_owner";--> statement-breakpoint
ALTER TABLE "registration_record" ALTER COLUMN "registered_owner" SET DATA TYPE "public"."registration_owner" USING "registered_owner"::"public"."registration_owner";--> statement-breakpoint
ALTER TABLE "payment_transaction" ALTER COLUMN "provider" SET DATA TYPE "public"."payment_provider" USING "provider"::"public"."payment_provider";--> statement-breakpoint
ALTER TABLE "installment" ADD COLUMN "contract_id" uuid;--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN "processing_token" uuid;--> statement-breakpoint
ALTER TABLE "inbox_message" ADD COLUMN "processing_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD COLUMN "posting_key" text;--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD COLUMN "channel" "payment_channel";--> statement-breakpoint
UPDATE installment AS target
SET contract_id = schedule.contract_id
FROM repayment_schedule AS schedule
WHERE schedule.id = target.repayment_schedule_id;--> statement-breakpoint
ALTER TABLE ledger_entry DISABLE TRIGGER ledger_entry_append_only;--> statement-breakpoint
UPDATE ledger_entry
SET posting_key = 'legacy:ledger:' || id::text;--> statement-breakpoint
ALTER TABLE ledger_entry ENABLE TRIGGER ledger_entry_append_only;--> statement-breakpoint
UPDATE payment_transaction
SET channel = (provider_payload->>'channel')::payment_channel;--> statement-breakpoint
ALTER TABLE "installment" ALTER COLUMN "contract_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "ledger_entry" ALTER COLUMN "posting_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_transaction" ALTER COLUMN "channel" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "installment_id_contract_unique" ON "installment" USING btree ("id","contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_schedule_id_contract_unique" ON "repayment_schedule" USING btree ("id","contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_transaction_id_contract_unique" ON "payment_transaction" USING btree ("id","contract_id");--> statement-breakpoint
ALTER TABLE "installment" ADD CONSTRAINT "installment_schedule_contract_fk" FOREIGN KEY ("repayment_schedule_id","contract_id") REFERENCES "public"."repayment_schedule"("id","contract_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_payment_contract_fk" FOREIGN KEY ("payment_transaction_id","contract_id") REFERENCES "public"."payment_transaction"("id","contract_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_installment_contract_fk" FOREIGN KEY ("installment_id","contract_id") REFERENCES "public"."installment"("id","contract_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_posting_key_unique" ON "ledger_entry" USING btree ("posting_key");--> statement-breakpoint
ALTER TABLE "installment" ADD CONSTRAINT "installment_paid_not_above_amount" CHECK ("installment"."paid_minor_units" <= "installment"."amount_minor_units");--> statement-breakpoint
ALTER TABLE "inbox_message" ADD CONSTRAINT "inbox_processing_lease_consistent" CHECK (("inbox_message"."processing_token" is null) = ("inbox_message"."processing_started_at" is null));
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'somo_runtime') THEN
    CREATE ROLE somo_runtime NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, privacy TO somo_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO somo_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA privacy TO somo_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO somo_runtime;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA privacy
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO somo_runtime;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE audit_event, ledger_entry FROM somo_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_ownership_transfer_settlement()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  agreement_status contract_status;
  agreement_balance bigint;
BEGIN
  IF NEW.status <> 'COMPLETED' THEN
    RETURN NEW;
  END IF;

  SELECT status, outstanding_balance_minor_units
    INTO agreement_status, agreement_balance
    FROM contract
    WHERE id = NEW.contract_id
    FOR UPDATE;

  IF FOUND AND (agreement_status <> 'SETTLED' OR agreement_balance <> 0) THEN
    RAISE EXCEPTION 'ownership transfer requires a settled zero-balance contract'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER ownership_transfer_requires_settlement
BEFORE INSERT OR UPDATE OF contract_id, status ON ownership_transfer
FOR EACH ROW EXECUTE FUNCTION enforce_ownership_transfer_settlement();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION enforce_customer_registration_transfer()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  completed_transfer_id uuid;
BEGIN
  IF NEW.registered_owner = 'CUSTOMER' THEN
    SELECT transfer.id
      INTO completed_transfer_id
      FROM ownership_transfer AS transfer
      JOIN contract AS agreement ON agreement.id = transfer.contract_id
      WHERE agreement.vehicle_unit_id = NEW.vehicle_unit_id
        AND transfer.status = 'COMPLETED'
      LIMIT 1
      FOR SHARE OF transfer, agreement;

    IF completed_transfer_id IS NULL THEN
      RAISE EXCEPTION 'customer registration requires completed ownership transfer'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER registration_customer_requires_transfer
BEFORE INSERT OR UPDATE OF vehicle_unit_id, registered_owner ON registration_record
FOR EACH ROW EXECUTE FUNCTION enforce_customer_registration_transfer();
