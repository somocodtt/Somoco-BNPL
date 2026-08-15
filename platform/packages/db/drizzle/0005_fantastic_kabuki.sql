CREATE TABLE "customer_session" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_account_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_session_token_hash_sha256" CHECK ("customer_session"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "customer_session_expiry_after_creation" CHECK ("customer_session"."expires_at" > "customer_session"."created_at")
);
--> statement-breakpoint
CREATE TABLE "privacy"."otp_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"invalidated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "otp_challenge_code_hash_sha256" CHECK ("privacy"."otp_challenge"."code_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "otp_challenge_attempts_nonnegative" CHECK ("privacy"."otp_challenge"."attempts" >= 0),
	CONSTRAINT "otp_challenge_expiry_after_creation" CHECK ("privacy"."otp_challenge"."expires_at" > "privacy"."otp_challenge"."created_at")
);
--> statement-breakpoint
ALTER TABLE "customer_session" ADD CONSTRAINT "customer_session_customer_account_id_customer_account_id_fk" FOREIGN KEY ("customer_account_id") REFERENCES "public"."customer_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy"."otp_challenge" ADD CONSTRAINT "otp_challenge_person_id_person_id_fk" FOREIGN KEY ("person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "customer_session_token_hash_unique" ON "customer_session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "customer_session_account_idx" ON "customer_session" USING btree ("customer_account_id");--> statement-breakpoint
CREATE INDEX "otp_challenge_person_created_idx" ON "privacy"."otp_challenge" USING btree ("person_id","created_at");