REVOKE UPDATE, DELETE ON TABLE "payment_receipt" FROM somo_runtime;
--> statement-breakpoint
GRANT UPDATE ("contract_id") ON TABLE "payment_receipt" TO somo_runtime;
