ALTER TABLE "outbox_attempt" DROP CONSTRAINT "outbox_attempt_outcome_allowed";--> statement-breakpoint
ALTER TABLE "outbox_attempt" DROP CONSTRAINT "outbox_attempt_outcome_consistent";--> statement-breakpoint
ALTER TABLE "outbox_message" DROP CONSTRAINT "outbox_claim_consistent";--> statement-breakpoint
ALTER TABLE "outbox_attempt" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "outbox_attempt" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "outbox_message" ADD COLUMN "claim_token" uuid;--> statement-breakpoint
UPDATE "outbox_attempt"
SET "lease_token" = gen_random_uuid(),
    "finished_at" = "attempted_at";--> statement-breakpoint
UPDATE "outbox_message"
SET "claim_token" = gen_random_uuid()
WHERE "claimed_by" IS NOT NULL;--> statement-breakpoint
INSERT INTO "outbox_attempt" (
  "outbox_message_id",
  "attempt_number",
  "worker_id",
  "lease_token",
  "attempted_at",
  "outcome"
)
SELECT "id",
       "attempts",
       "claimed_by",
       "claim_token",
       "claimed_at",
       'STARTED'
FROM "outbox_message"
WHERE "claimed_by" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_attempt" ALTER COLUMN "lease_token" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_attempt" ADD CONSTRAINT "outbox_attempt_outcome_allowed" CHECK ("outbox_attempt"."outcome" in ('STARTED', 'ABANDONED', 'PUBLISHED', 'RETRY_SCHEDULED', 'EXCEPTION'));--> statement-breakpoint
ALTER TABLE "outbox_attempt" ADD CONSTRAINT "outbox_attempt_outcome_consistent" CHECK ((
        ("outbox_attempt"."outcome" = 'STARTED' and "outbox_attempt"."finished_at" is null and "outbox_attempt"."failure_code" is null and "outbox_attempt"."next_attempt_at" is null)
        or ("outbox_attempt"."outcome" = 'ABANDONED' and "outbox_attempt"."finished_at" is not null and "outbox_attempt"."failure_code" is not null and "outbox_attempt"."next_attempt_at" is null)
        or ("outbox_attempt"."outcome" = 'PUBLISHED' and "outbox_attempt"."finished_at" is not null and "outbox_attempt"."failure_code" is null and "outbox_attempt"."next_attempt_at" is null)
        or ("outbox_attempt"."outcome" = 'RETRY_SCHEDULED' and "outbox_attempt"."finished_at" is not null and "outbox_attempt"."failure_code" is not null and "outbox_attempt"."next_attempt_at" is not null)
        or ("outbox_attempt"."outcome" = 'EXCEPTION' and "outbox_attempt"."finished_at" is not null and "outbox_attempt"."failure_code" is not null and "outbox_attempt"."next_attempt_at" is null)
      ));--> statement-breakpoint
ALTER TABLE "outbox_message" ADD CONSTRAINT "outbox_claim_consistent" CHECK ((
        ("outbox_message"."claimed_by" is null and "outbox_message"."claim_token" is null and "outbox_message"."claimed_at" is null)
        or ("outbox_message"."claimed_by" is not null and "outbox_message"."claim_token" is not null and "outbox_message"."claimed_at" is not null)
      ));
