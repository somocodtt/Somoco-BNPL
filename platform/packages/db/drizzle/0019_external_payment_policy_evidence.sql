ALTER TABLE "payment_allocation_policy"
  ADD COLUMN "behavior_digest" text,
  ADD COLUMN "evidence_hash" text,
  ADD COLUMN "evidence_artifact" jsonb,
  ADD COLUMN "finance_signature" text,
  ADD COLUMN "compliance_signature" text,
  ADD COLUMN "finance_approved_at" timestamp with time zone,
  ADD COLUMN "compliance_approved_at" timestamp with time zone;--> statement-breakpoint
UPDATE "payment_allocation_policy"
   SET "status" = 'REVOKED'
 WHERE "status" = 'APPROVED'
   AND ("behavior_digest" IS NULL
     OR "evidence_hash" IS NULL
     OR "evidence_artifact" IS NULL
     OR "finance_signature" IS NULL
     OR "compliance_signature" IS NULL
     OR "finance_approved_at" IS NULL
     OR "compliance_approved_at" IS NULL);--> statement-breakpoint
ALTER TABLE "payment_allocation_policy"
  ADD CONSTRAINT "payment_allocation_policy_behavior_digest_sha256"
    CHECK ("behavior_digest" IS NULL OR "behavior_digest" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "payment_allocation_policy_evidence_hash_sha256"
    CHECK ("evidence_hash" IS NULL OR "evidence_hash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "payment_allocation_policy_approved_external_evidence"
    CHECK ("status" <> 'APPROVED' OR (
      "behavior_digest" IS NOT NULL
      AND "evidence_hash" IS NOT NULL
      AND "evidence_artifact" IS NOT NULL
      AND "finance_signature" IS NOT NULL
      AND length(btrim("finance_signature")) > 0
      AND "compliance_signature" IS NOT NULL
      AND length(btrim("compliance_signature")) > 0
      AND "finance_approved_at" IS NOT NULL
      AND "compliance_approved_at" IS NOT NULL
    ));
