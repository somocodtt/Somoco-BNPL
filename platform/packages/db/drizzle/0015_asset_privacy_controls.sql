ALTER TABLE "tracker_association"
  ALTER COLUMN "deep_link" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "contract_execution"
  DROP CONSTRAINT "contract_execution_signatures_nonempty",
  ALTER COLUMN "applicant_signature" DROP NOT NULL,
  ALTER COLUMN "guarantor_signature" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "contract_execution"
  ADD COLUMN "applicant_person_id" uuid,
  ADD COLUMN "guarantor_person_id" uuid;
--> statement-breakpoint
ALTER TABLE "contract_execution"
  ADD CONSTRAINT "contract_execution_applicant_person_fk"
    FOREIGN KEY ("applicant_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict,
  ADD CONSTRAINT "contract_execution_guarantor_person_fk"
    FOREIGN KEY ("guarantor_person_id") REFERENCES "privacy"."person"("id") ON DELETE restrict;
