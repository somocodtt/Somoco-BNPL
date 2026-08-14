CREATE TABLE "outbox_attempt" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_message_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"worker_id" text NOT NULL,
	"attempted_at" timestamp with time zone NOT NULL,
	"outcome" text NOT NULL,
	"failure_code" text,
	"next_attempt_at" timestamp with time zone,
	CONSTRAINT "outbox_attempt_number_positive" CHECK ("outbox_attempt"."attempt_number" > 0),
	CONSTRAINT "outbox_attempt_outcome_allowed" CHECK ("outbox_attempt"."outcome" in ('PUBLISHED', 'RETRY_SCHEDULED', 'EXCEPTION')),
	CONSTRAINT "outbox_attempt_failure_code_safe" CHECK ("outbox_attempt"."failure_code" is null or "outbox_attempt"."failure_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "outbox_attempt_outcome_consistent" CHECK ((
        ("outbox_attempt"."outcome" = 'PUBLISHED' and "outbox_attempt"."failure_code" is null and "outbox_attempt"."next_attempt_at" is null)
        or ("outbox_attempt"."outcome" = 'RETRY_SCHEDULED' and "outbox_attempt"."failure_code" is not null and "outbox_attempt"."next_attempt_at" is not null)
        or ("outbox_attempt"."outcome" = 'EXCEPTION' and "outbox_attempt"."failure_code" is not null and "outbox_attempt"."next_attempt_at" is null)
      ))
);
--> statement-breakpoint
DROP INDEX "outbox_dispatch_idx";--> statement-breakpoint
ALTER TABLE "outbox_message" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_message" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_message" ADD COLUMN "exception_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_attempt" ADD CONSTRAINT "outbox_attempt_outbox_message_id_outbox_message_id_fk" FOREIGN KEY ("outbox_message_id") REFERENCES "public"."outbox_message"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_attempt_number_unique" ON "outbox_attempt" USING btree ("outbox_message_id","attempt_number");--> statement-breakpoint
CREATE INDEX "outbox_dispatch_idx" ON "outbox_message" USING btree ("published_at","exception_at","available_at","claimed_at","occurred_at");--> statement-breakpoint
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_claim_consistent" CHECK (("outbox_message"."claimed_by" is null) = ("outbox_message"."claimed_at" is null));--> statement-breakpoint
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_terminal_state_exclusive" CHECK (not ("outbox_message"."published_at" is not null and "outbox_message"."exception_at" is not null));