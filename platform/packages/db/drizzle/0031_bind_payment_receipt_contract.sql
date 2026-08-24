CREATE OR REPLACE FUNCTION prevent_payment_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_TABLE_NAME = 'payment_receipt'
     AND OLD.contract_id IS NULL
     AND NEW.contract_id IS NOT NULL
     AND (to_jsonb(OLD) - 'contract_id') = (to_jsonb(NEW) - 'contract_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'payment financial history is append-only'
    USING ERRCODE = '55000';
END;
$$;
