DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'somo_runtime') THEN
    CREATE ROLE somo_runtime NOLOGIN;
  END IF;
END $$;--> statement-breakpoint
GRANT SELECT ON TABLE "payment_allocation_policy" TO somo_runtime;--> statement-breakpoint
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE "payment_allocation_policy" FROM somo_runtime;
