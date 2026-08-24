ALTER TYPE "public"."staff_role" ADD VALUE 'INVENTORY_OFFICER';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'FINANCE_OFFICER';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'RECOVERY_OFFICER';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'COMPLIANCE_AUDITOR';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'CUSTOMER_SUPPORT';--> statement-breakpoint
ALTER TYPE "public"."staff_role" ADD VALUE 'SYSTEM_ADMIN';--> statement-breakpoint
ALTER TABLE "staff_session" ADD COLUMN "mfa_verified" boolean;--> statement-breakpoint
UPDATE "staff_session" SET "mfa_verified" = false WHERE "mfa_verified" IS NULL;--> statement-breakpoint
ALTER TABLE "staff_session" ALTER COLUMN "mfa_verified" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_token_hash_sha256" CHECK ("staff_session"."token_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "staff_session" ADD CONSTRAINT "staff_session_expiry_after_creation" CHECK ("staff_session"."expires_at" > "staff_session"."created_at");
