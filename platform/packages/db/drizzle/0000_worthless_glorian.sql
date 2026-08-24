CREATE SCHEMA "privacy";
--> statement-breakpoint
CREATE TYPE "public"."staff_role" AS ENUM('VERIFICATION_OFFICER', 'BSM', 'AGM', 'CFO', 'MD', 'PRODUCT_ADMIN');--> statement-breakpoint
CREATE TYPE "public"."staff_user_status" AS ENUM('ACTIVE', 'DISABLED', 'LOCKED');--> statement-breakpoint
CREATE TYPE "public"."application_status" AS ENUM('DRAFT', 'AWAITING_GUARANTOR', 'READY_TO_SUBMIT', 'VERIFICATION_REVIEW', 'BSM_INITIAL_REVIEW', 'AGM_REVIEW', 'CFO_REVIEW', 'BSM_FINAL_REVIEW', 'MD_REVIEW', 'INFORMATION_REQUESTED', 'REJECTED', 'APPROVED', 'AWAITING_DEPOSIT', 'AWAITING_ASSET_ASSIGNMENT', 'AWAITING_EXECUTION', 'ACTIVE', 'SETTLED', 'RECOVERY');--> statement-breakpoint
CREATE TYPE "public"."approval_action" AS ENUM('APPROVE', 'REJECT', 'REQUEST_INFORMATION');--> statement-breakpoint
CREATE TYPE "public"."approval_stage" AS ENUM('VERIFICATION', 'BSM_INITIAL', 'AGM', 'CFO', 'BSM_FINAL', 'MD');--> statement-breakpoint
CREATE TYPE "public"."guarantor_status" AS ENUM('INVITED', 'IN_PROGRESS', 'CONFIRMED', 'DECLINED');--> statement-breakpoint
CREATE TYPE "public"."vehicle_status" AS ENUM('IN_STOCK', 'RESERVED', 'ASSIGNED', 'HANDED_OVER', 'RECOVERED', 'TRANSFERRED');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('DRAFT', 'AWAITING_EXECUTION', 'EXECUTED', 'ACTIVE', 'SETTLED', 'RECOVERY', 'TERMINATED');--> statement-breakpoint
CREATE TYPE "public"."installment_status" AS ENUM('PENDING', 'PARTIALLY_PAID', 'PAID', 'OVERDUE', 'WAIVED');--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('QUEUED', 'SENT', 'DELIVERED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."ledger_direction" AS ENUM('DEBIT', 'CREDIT');--> statement-breakpoint
CREATE TYPE "public"."ledger_entry_type" AS ENUM('DEPOSIT', 'REPAYMENT', 'REVERSAL', 'REFUND', 'ADJUSTMENT');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('RECEIVED', 'MATCHED', 'POSTED', 'REVERSED', 'REFUNDED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."document_status" AS ENUM('UPLOADED', 'SCANNING', 'ACCEPTED', 'REJECTED', 'QUARANTINED');--> statement-breakpoint
CREATE TYPE "public"."identity_check_status" AS ENUM('PENDING', 'VERIFIED', 'FAILED', 'MANUAL_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('DRAFT', 'ACTIVE', 'RETIRED');--> statement-breakpoint
CREATE TYPE "public"."repayment_frequency" AS ENUM('WEEKLY', 'MONTHLY');--> statement-breakpoint
CREATE TABLE "customer_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_account_status_allowed" CHECK ("customer_account"."status" in ('ACTIVE', 'DISABLED')),
	CONSTRAINT "customer_account_version_positive" CHECK ("customer_account"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "staff_role_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"role" "staff_role" NOT NULL,
	"assigned_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"staff_user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "staff_user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"status" "staff_user_status" DEFAULT 'ACTIVE' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_user_version_positive" CHECK ("staff_user"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"applicant_person_id" uuid NOT NULL,
	"product_id" uuid,
	"vehicle_model_id" uuid,
	"status" "application_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"submitted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_version_positive" CHECK ("application"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "application_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "application_version_number_positive" CHECK ("application_version"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "approval_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_version_id" uuid NOT NULL,
	"stage" "approval_stage" NOT NULL,
	"action" "approval_action" NOT NULL,
	"reason" text,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"profile_data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_profile_version_positive" CHECK ("customer_profile"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "exception_request" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"proposed_value" jsonb NOT NULL,
	"policy_value" jsonb NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"requested_by" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "exception_request_status_allowed" CHECK ("exception_request"."status" in ('PENDING', 'APPROVED', 'REJECTED')),
	CONSTRAINT "exception_request_version_positive" CHECK ("exception_request"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "guarantor_relationship" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"guarantor_person_id" uuid NOT NULL,
	"status" "guarantor_status" DEFAULT 'INVITED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"invited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	CONSTRAINT "guarantor_relationship_version_positive" CHECK ("guarantor_relationship"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "offer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"accepted_version_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_version_positive" CHECK ("offer"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "offer_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"offer_id" uuid NOT NULL,
	"financing_rule_version_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"principal_minor_units" bigint NOT NULL,
	"deposit_minor_units" bigint NOT NULL,
	"total_payable_minor_units" bigint NOT NULL,
	"terms" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "offer_version_number_positive" CHECK ("offer_version"."version_number" > 0),
	CONSTRAINT "offer_principal_nonnegative" CHECK ("offer_version"."principal_minor_units" >= 0),
	CONSTRAINT "offer_deposit_nonnegative" CHECK ("offer_version"."deposit_minor_units" >= 0),
	CONSTRAINT "offer_total_payable_nonnegative" CHECK ("offer_version"."total_payable_minor_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "underwriting_assessment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_version_id" uuid NOT NULL,
	"assessment" jsonb NOT NULL,
	"assessed_by" uuid,
	"assessed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "insurance_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_unit_id" uuid NOT NULL,
	"policy_number" text NOT NULL,
	"provider" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date NOT NULL,
	"evidence_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "insurance_date_order" CHECK ("insurance_record"."valid_to" >= "insurance_record"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "registration_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_unit_id" uuid NOT NULL,
	"registration_number" text NOT NULL,
	"registered_owner" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"evidence_document_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tracker_association_id" uuid NOT NULL,
	"actor_staff_user_id" uuid NOT NULL,
	"recovery_case_id" uuid,
	"purpose" text NOT NULL,
	"accessed_at" timestamp with time zone NOT NULL,
	"context" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tracker_association" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_unit_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_device_id" text NOT NULL,
	"deep_link" text NOT NULL,
	"associated_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vehicle_assignment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"vehicle_unit_id" uuid NOT NULL,
	"assigned_by" uuid NOT NULL,
	"assigned_at" timestamp with time zone NOT NULL,
	"released_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "vehicle_unit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vehicle_model_id" uuid NOT NULL,
	"vin" text NOT NULL,
	"chassis_number" text NOT NULL,
	"registration_number" text,
	"status" "vehicle_status" DEFAULT 'IN_STOCK' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_unit_version_positive" CHECK ("vehicle_unit"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "audit_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_staff_user_id" uuid,
	"request_id" uuid,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reference" text NOT NULL,
	"application_id" uuid NOT NULL,
	"offer_version_id" uuid NOT NULL,
	"vehicle_unit_id" uuid NOT NULL,
	"status" "contract_status" DEFAULT 'DRAFT' NOT NULL,
	"outstanding_balance_minor_units" bigint NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"activated_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contract_balance_nonnegative" CHECK ("contract"."outstanding_balance_minor_units" >= 0),
	CONSTRAINT "contract_version_positive" CHECK ("contract"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "handover_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"checklist" jsonb NOT NULL,
	"handed_over_by" uuid NOT NULL,
	"handed_over_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "installment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"repayment_schedule_id" uuid NOT NULL,
	"installment_number" integer NOT NULL,
	"due_date" date NOT NULL,
	"amount_minor_units" bigint NOT NULL,
	"paid_minor_units" bigint DEFAULT 0 NOT NULL,
	"status" "installment_status" DEFAULT 'PENDING' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "installment_number_positive" CHECK ("installment"."installment_number" > 0),
	CONSTRAINT "installment_amount_nonnegative" CHECK ("installment"."amount_minor_units" >= 0),
	CONSTRAINT "installment_paid_nonnegative" CHECK ("installment"."paid_minor_units" >= 0),
	CONSTRAINT "installment_version_positive" CHECK ("installment"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "ownership_transfer" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"evidence" jsonb,
	"approved_by" uuid,
	"transferred_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_transfer_status_allowed" CHECK ("ownership_transfer"."status" in ('PENDING', 'APPROVED', 'COMPLETED', 'REJECTED')),
	CONSTRAINT "ownership_transfer_version_positive" CHECK ("ownership_transfer"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "recovery_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"assigned_officer_id" uuid,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"opened_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	CONSTRAINT "recovery_case_status_allowed" CHECK ("recovery_case"."status" in ('OPEN', 'IN_PROGRESS', 'CLOSED')),
	CONSTRAINT "recovery_case_version_positive" CHECK ("recovery_case"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "repayment_schedule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"total_minor_units" bigint NOT NULL,
	"first_due_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repayment_schedule_total_nonnegative" CHECK ("repayment_schedule"."total_minor_units" >= 0),
	CONSTRAINT "repayment_schedule_version_positive" CHECK ("repayment_schedule"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "delivery_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notification_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text,
	"attempt_number" integer NOT NULL,
	"response" jsonb,
	"attempted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "delivery_attempt_number_positive" CHECK ("delivery_attempt"."attempt_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "inbox_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel" text NOT NULL,
	"recipient_reference" text NOT NULL,
	"template" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "notification_status" DEFAULT 'QUEUED' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_version_positive" CHECK ("notification"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "outbox_message" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"topic" text NOT NULL,
	"aggregate_type" text NOT NULL,
	"aggregate_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"claimed_by" text,
	"claimed_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_attempts_nonnegative" CHECK ("outbox_message"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "migration_batch" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"source_batch_id" text NOT NULL,
	"status" text DEFAULT 'QUARANTINED' NOT NULL,
	"expected_records" integer NOT NULL,
	"imported_records" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_batch_status_allowed" CHECK ("migration_batch"."status" in ('QUARANTINED', 'VALIDATED', 'APPROVED', 'IMPORTED', 'REJECTED')),
	CONSTRAINT "migration_expected_nonnegative" CHECK ("migration_batch"."expected_records" >= 0),
	CONSTRAINT "migration_imported_nonnegative" CHECK ("migration_batch"."imported_records" >= 0),
	CONSTRAINT "migration_batch_version_positive" CHECK ("migration_batch"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "migration_record" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"migration_batch_id" uuid NOT NULL,
	"source_record_id" text NOT NULL,
	"status" text DEFAULT 'QUARANTINED' NOT NULL,
	"payload" jsonb NOT NULL,
	"errors" jsonb,
	"target_type" text,
	"target_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "migration_record_status_allowed" CHECK ("migration_record"."status" in ('QUARANTINED', 'VALID', 'INVALID', 'IMPORTED', 'REJECTED'))
);
--> statement-breakpoint
CREATE TABLE "arrears_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"overdue_minor_units" bigint NOT NULL,
	"unpaid_installments" integer NOT NULL,
	"consecutive_missed_installments" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "arrears_overdue_nonnegative" CHECK ("arrears_snapshot"."overdue_minor_units" >= 0),
	CONSTRAINT "arrears_unpaid_nonnegative" CHECK ("arrears_snapshot"."unpaid_installments" >= 0),
	CONSTRAINT "arrears_consecutive_nonnegative" CHECK ("arrears_snapshot"."consecutive_missed_installments" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ledger_entry" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"payment_transaction_id" uuid,
	"installment_id" uuid,
	"entry_type" "ledger_entry_type" NOT NULL,
	"direction" "ledger_direction" NOT NULL,
	"currency" text DEFAULT 'GHS' NOT NULL,
	"amount_minor_units" bigint NOT NULL,
	"balance_after_minor_units" bigint NOT NULL,
	"reverses_entry_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_currency_ghs" CHECK ("ledger_entry"."currency" = 'GHS'),
	CONSTRAINT "ledger_amount_positive" CHECK ("ledger_entry"."amount_minor_units" > 0),
	CONSTRAINT "ledger_balance_nonnegative" CHECK ("ledger_entry"."balance_after_minor_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_transaction" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_transaction_id" text NOT NULL,
	"contract_id" uuid,
	"payer_reference" text NOT NULL,
	"currency" text DEFAULT 'GHS' NOT NULL,
	"amount_minor_units" bigint NOT NULL,
	"status" "payment_status" DEFAULT 'RECEIVED' NOT NULL,
	"provider_payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_currency_ghs" CHECK ("payment_transaction"."currency" = 'GHS'),
	CONSTRAINT "payment_amount_nonnegative" CHECK ("payment_transaction"."amount_minor_units" >= 0),
	CONSTRAINT "payment_version_positive" CHECK ("payment_transaction"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "reconciliation_case" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_transaction_id" uuid,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"reason" text NOT NULL,
	"resolution" jsonb,
	"resolved_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reconciliation_case_status_allowed" CHECK ("reconciliation_case"."status" in ('OPEN', 'INVESTIGATING', 'RESOLVED')),
	CONSTRAINT "reconciliation_case_version_positive" CHECK ("reconciliation_case"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "privacy"."consent_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"policy_version" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "privacy"."document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"document_type" text NOT NULL,
	"object_key" text NOT NULL,
	"sha256" text NOT NULL,
	"status" "document_status" DEFAULT 'UPLOADED' NOT NULL,
	"malware_scanned" boolean DEFAULT false NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_version_positive" CHECK ("privacy"."document"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "privacy"."identity_check" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_reference" text NOT NULL,
	"status" "identity_check_status" NOT NULL,
	"evidence" jsonb NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "privacy"."person" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"phone_e164" text NOT NULL,
	"email_ciphertext" text,
	"full_name_ciphertext" text,
	"ghana_card_ciphertext" text,
	"ghana_card_fingerprint" text,
	"date_of_birth_ciphertext" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_version_positive" CHECK ("privacy"."person"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "privacy"."signature_evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"signed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financing_rule_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"minimum_deposit_minor_units" bigint NOT NULL,
	"annual_rate_bps" numeric(9, 0) NOT NULL,
	"allowed_tenures_months" jsonb NOT NULL,
	"repayment_frequencies" jsonb NOT NULL,
	"calculation_method" text NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"effective_from" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "financing_rule_minimum_deposit_nonnegative" CHECK ("financing_rule_version"."minimum_deposit_minor_units" >= 0),
	CONSTRAINT "financing_rule_rate_bps_nonnegative" CHECK ("financing_rule_version"."annual_rate_bps" >= 0),
	CONSTRAINT "financing_rule_version_positive" CHECK ("financing_rule_version"."version_number" > 0)
);
--> statement-breakpoint
CREATE TABLE "product" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"vehicle_model_id" uuid NOT NULL,
	"status" "product_status" DEFAULT 'DRAFT' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_version_positive" CHECK ("product"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "vehicle_model" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"manufacturer" text NOT NULL,
	"model_name" text NOT NULL,
	"model_year" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vehicle_model_year_valid" CHECK ("vehicle_model"."model_year" between 1900 and 2200),
	CONSTRAINT "vehicle_model_version_positive" CHECK ("vehicle_model"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_account" ADD CONSTRAINT "customer_account_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_role_assignment" ADD CONSTRAINT "staff_role_assignment_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_staff_user_id_staff_user_id_fk" FOREIGN KEY ("staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_applicant_person_id_person_id_fk" FOREIGN KEY ("applicant_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application" ADD CONSTRAINT "application_vehicle_model_id_vehicle_model_id_fk" FOREIGN KEY ("vehicle_model_id") REFERENCES "public"."vehicle_model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_version" ADD CONSTRAINT "application_version_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_application_version_id_application_version_id_fk" FOREIGN KEY ("application_version_id") REFERENCES "public"."application_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_decision" ADD CONSTRAINT "approval_decision_decided_by_staff_user_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_profile" ADD CONSTRAINT "customer_profile_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_request" ADD CONSTRAINT "exception_request_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "exception_request" ADD CONSTRAINT "exception_request_requested_by_staff_user_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantor_relationship" ADD CONSTRAINT "guarantor_relationship_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guarantor_relationship" ADD CONSTRAINT "guarantor_relationship_guarantor_person_id_person_id_fk" FOREIGN KEY ("guarantor_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_version" ADD CONSTRAINT "offer_version_offer_id_offer_id_fk" FOREIGN KEY ("offer_id") REFERENCES "public"."offer"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offer_version" ADD CONSTRAINT "offer_version_financing_rule_version_id_financing_rule_version_id_fk" FOREIGN KEY ("financing_rule_version_id") REFERENCES "public"."financing_rule_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "underwriting_assessment" ADD CONSTRAINT "underwriting_assessment_application_version_id_application_version_id_fk" FOREIGN KEY ("application_version_id") REFERENCES "public"."application_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "underwriting_assessment" ADD CONSTRAINT "underwriting_assessment_assessed_by_staff_user_id_fk" FOREIGN KEY ("assessed_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_record" ADD CONSTRAINT "insurance_record_vehicle_unit_id_vehicle_unit_id_fk" FOREIGN KEY ("vehicle_unit_id") REFERENCES "public"."vehicle_unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_record" ADD CONSTRAINT "registration_record_vehicle_unit_id_vehicle_unit_id_fk" FOREIGN KEY ("vehicle_unit_id") REFERENCES "public"."vehicle_unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_access_log" ADD CONSTRAINT "tracker_access_log_tracker_association_id_tracker_association_id_fk" FOREIGN KEY ("tracker_association_id") REFERENCES "public"."tracker_association"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_access_log" ADD CONSTRAINT "tracker_access_log_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_association" ADD CONSTRAINT "tracker_association_vehicle_unit_id_vehicle_unit_id_fk" FOREIGN KEY ("vehicle_unit_id") REFERENCES "public"."vehicle_unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_vehicle_unit_id_vehicle_unit_id_fk" FOREIGN KEY ("vehicle_unit_id") REFERENCES "public"."vehicle_unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_assignment" ADD CONSTRAINT "vehicle_assignment_assigned_by_staff_user_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_unit" ADD CONSTRAINT "vehicle_unit_vehicle_model_id_vehicle_model_id_fk" FOREIGN KEY ("vehicle_model_id") REFERENCES "public"."vehicle_model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_staff_user_id_staff_user_id_fk" FOREIGN KEY ("actor_staff_user_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_application_id_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."application"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_offer_version_id_offer_version_id_fk" FOREIGN KEY ("offer_version_id") REFERENCES "public"."offer_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contract" ADD CONSTRAINT "contract_vehicle_unit_id_vehicle_unit_id_fk" FOREIGN KEY ("vehicle_unit_id") REFERENCES "public"."vehicle_unit"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_record" ADD CONSTRAINT "handover_record_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handover_record" ADD CONSTRAINT "handover_record_handed_over_by_staff_user_id_fk" FOREIGN KEY ("handed_over_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "installment" ADD CONSTRAINT "installment_repayment_schedule_id_repayment_schedule_id_fk" FOREIGN KEY ("repayment_schedule_id") REFERENCES "public"."repayment_schedule"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_transfer" ADD CONSTRAINT "ownership_transfer_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_transfer" ADD CONSTRAINT "ownership_transfer_approved_by_staff_user_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_case" ADD CONSTRAINT "recovery_case_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recovery_case" ADD CONSTRAINT "recovery_case_assigned_officer_id_staff_user_id_fk" FOREIGN KEY ("assigned_officer_id") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repayment_schedule" ADD CONSTRAINT "repayment_schedule_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delivery_attempt" ADD CONSTRAINT "delivery_attempt_notification_id_notification_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notification"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_record" ADD CONSTRAINT "migration_record_migration_batch_id_migration_batch_id_fk" FOREIGN KEY ("migration_batch_id") REFERENCES "public"."migration_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "arrears_snapshot" ADD CONSTRAINT "arrears_snapshot_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_payment_transaction_id_payment_transaction_id_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."payment_transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_installment_id_installment_id_fk" FOREIGN KEY ("installment_id") REFERENCES "public"."installment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_transaction" ADD CONSTRAINT "payment_transaction_contract_id_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."contract"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_case" ADD CONSTRAINT "reconciliation_case_payment_transaction_id_payment_transaction_id_fk" FOREIGN KEY ("payment_transaction_id") REFERENCES "public"."payment_transaction"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_case" ADD CONSTRAINT "reconciliation_case_resolved_by_staff_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."staff_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."consent_evidence" ADD CONSTRAINT "consent_evidence_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."document" ADD CONSTRAINT "document_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."identity_check" ADD CONSTRAINT "identity_check_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."signature_evidence" ADD CONSTRAINT "signature_evidence_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financing_rule_version" ADD CONSTRAINT "financing_rule_version_product_id_product_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."product"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product" ADD CONSTRAINT "product_vehicle_model_id_vehicle_model_id_fk" FOREIGN KEY ("vehicle_model_id") REFERENCES "public"."vehicle_model"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_account_person_unique" ON "customer_account" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_role_assignment_unique" ON "staff_role_assignment" USING btree ("staff_user_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_session_token_hash_unique" ON "staff_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "staff_session_user_idx" ON "staff_session" USING btree ("staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_user_email_unique" ON "staff_user" USING btree ("email");--> statement-breakpoint
CREATE INDEX "application_applicant_idx" ON "application" USING btree ("applicant_person_id");--> statement-breakpoint
CREATE INDEX "application_status_idx" ON "application" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "application_version_number_unique" ON "application_version" USING btree ("application_id","version_number");--> statement-breakpoint
CREATE INDEX "approval_decision_application_stage_idx" ON "approval_decision" USING btree ("application_version_id","stage");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_profile_person_unique" ON "customer_profile" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guarantor_application_person_unique" ON "guarantor_relationship" USING btree ("application_id","guarantor_person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_application_unique" ON "offer" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offer_version_number_unique" ON "offer_version" USING btree ("offer_id","version_number");--> statement-breakpoint
CREATE INDEX "underwriting_application_version_idx" ON "underwriting_assessment" USING btree ("application_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "insurance_policy_number_unique" ON "insurance_record" USING btree ("policy_number");--> statement-breakpoint
CREATE INDEX "registration_vehicle_idx" ON "registration_record" USING btree ("vehicle_unit_id");--> statement-breakpoint
CREATE INDEX "tracker_access_actor_idx" ON "tracker_access_log" USING btree ("actor_staff_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tracker_provider_device_unique" ON "tracker_association" USING btree ("provider","provider_device_id");--> statement-breakpoint
CREATE INDEX "vehicle_assignment_application_idx" ON "vehicle_assignment" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_assignment_active_vehicle_unique" ON "vehicle_assignment" USING btree ("vehicle_unit_id") WHERE "vehicle_assignment"."released_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_unit_vin_unique" ON "vehicle_unit" USING btree ("vin");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_unit_chassis_unique" ON "vehicle_unit" USING btree ("chassis_number");--> statement-breakpoint
CREATE INDEX "audit_aggregate_idx" ON "audit_event" USING btree ("aggregate_type","aggregate_id");--> statement-breakpoint
CREATE INDEX "audit_occurred_idx" ON "audit_event" USING btree ("occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_reference_unique" ON "contract" USING btree ("reference");--> statement-breakpoint
CREATE UNIQUE INDEX "contract_application_unique" ON "contract" USING btree ("application_id");--> statement-breakpoint
CREATE UNIQUE INDEX "handover_contract_unique" ON "handover_record" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "installment_schedule_number_unique" ON "installment" USING btree ("repayment_schedule_id","installment_number");--> statement-breakpoint
CREATE INDEX "installment_due_date_idx" ON "installment" USING btree ("due_date");--> statement-breakpoint
CREATE UNIQUE INDEX "ownership_transfer_contract_unique" ON "ownership_transfer" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "recovery_case_contract_idx" ON "recovery_case" USING btree ("contract_id");--> statement-breakpoint
CREATE UNIQUE INDEX "repayment_schedule_contract_version_unique" ON "repayment_schedule" USING btree ("contract_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "delivery_attempt_number_unique" ON "delivery_attempt" USING btree ("notification_id","attempt_number");--> statement-breakpoint
CREATE UNIQUE INDEX "inbox_provider_event_unique" ON "inbox_message" USING btree ("provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "inbox_unprocessed_idx" ON "inbox_message" USING btree ("received_at") WHERE "inbox_message"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_idempotency_unique" ON "notification" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "outbox_dispatch_idx" ON "outbox_message" USING btree ("published_at","claimed_at","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_source_batch_unique" ON "migration_batch" USING btree ("source","source_batch_id");--> statement-breakpoint
CREATE UNIQUE INDEX "migration_record_source_unique" ON "migration_record" USING btree ("migration_batch_id","source_record_id");--> statement-breakpoint
CREATE INDEX "migration_record_status_idx" ON "migration_record" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "arrears_contract_date_unique" ON "arrears_snapshot" USING btree ("contract_id","as_of_date");--> statement-breakpoint
CREATE INDEX "ledger_contract_occurred_idx" ON "ledger_entry" USING btree ("contract_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_provider_transaction_unique" ON "payment_transaction" USING btree ("provider","provider_transaction_id");--> statement-breakpoint
CREATE INDEX "payment_contract_idx" ON "payment_transaction" USING btree ("contract_id");--> statement-breakpoint
CREATE INDEX "consent_evidence_person_idx" ON "privacy"."consent_evidence" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_object_key_unique" ON "privacy"."document" USING btree ("object_key");--> statement-breakpoint
CREATE INDEX "document_person_idx" ON "privacy"."document" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_check_provider_reference_unique" ON "privacy"."identity_check" USING btree ("provider","provider_reference");--> statement-breakpoint
CREATE INDEX "identity_check_person_idx" ON "privacy"."identity_check" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_phone_e164_unique" ON "privacy"."person" USING btree ("phone_e164");--> statement-breakpoint
CREATE UNIQUE INDEX "person_ghana_card_fingerprint_unique" ON "privacy"."person" USING btree ("ghana_card_fingerprint") WHERE "privacy"."person"."ghana_card_fingerprint" is not null;--> statement-breakpoint
CREATE INDEX "signature_evidence_person_idx" ON "privacy"."signature_evidence" USING btree ("person_id");--> statement-breakpoint
CREATE UNIQUE INDEX "financing_rule_product_version_unique" ON "financing_rule_version" USING btree ("product_id","version_number");--> statement-breakpoint
CREATE UNIQUE INDEX "product_code_unique" ON "product" USING btree ("code");--> statement-breakpoint
CREATE INDEX "product_vehicle_model_idx" ON "product" USING btree ("vehicle_model_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vehicle_model_identity_unique" ON "vehicle_model" USING btree ("manufacturer","model_name","model_year");--> statement-breakpoint
ALTER TABLE "offer" ADD CONSTRAINT "offer_accepted_version_id_offer_version_id_fk" FOREIGN KEY ("accepted_version_id") REFERENCES "public"."offer_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "insurance_record" ADD CONSTRAINT "insurance_record_evidence_document_id_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "privacy"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_record" ADD CONSTRAINT "registration_record_evidence_document_id_document_id_fk" FOREIGN KEY ("evidence_document_id") REFERENCES "privacy"."document"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracker_access_log" ADD CONSTRAINT "tracker_access_log_recovery_case_id_recovery_case_id_fk" FOREIGN KEY ("recovery_case_id") REFERENCES "public"."recovery_case"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entry" ADD CONSTRAINT "ledger_entry_reverses_entry_id_ledger_entry_id_fk" FOREIGN KEY ("reverses_entry_id") REFERENCES "public"."ledger_entry"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "audit_event" FROM PUBLIC;--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE "ledger_entry" FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION prevent_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER audit_event_append_only
BEFORE UPDATE OR DELETE ON "audit_event"
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();--> statement-breakpoint
CREATE TRIGGER ledger_entry_append_only
BEFORE UPDATE OR DELETE ON "ledger_entry"
FOR EACH ROW EXECUTE FUNCTION prevent_append_only_mutation();
