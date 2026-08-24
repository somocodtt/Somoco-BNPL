DO $$
DECLARE
  affected_original_ids text;
BEGIN
  SELECT string_agg(original_id::text, ', ' ORDER BY original_id::text)
    INTO affected_original_ids
    FROM (
      SELECT original.id AS original_id
        FROM payment_transaction compensation
        JOIN payment_transaction original
          ON original.id = compensation.original_payment_transaction_id
          OR (
            original.provider = compensation.provider
            AND original.provider_transaction_id =
                compensation.provider_payload->>'originalProviderTransactionId'
          )
       WHERE compensation.event_type IN ('PAYMENT_REVERSED', 'PAYMENT_REFUNDED')
       GROUP BY original.id
      HAVING count(DISTINCT compensation.id) > 1
    ) historical_multiple_compensations;

  IF affected_original_ids IS NOT NULL THEN
    RAISE EXCEPTION 'HISTORICAL_MULTIPLE_PAYMENT_COMPENSATIONS_REMEDIATION_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'Affected original payment identifiers: %s.',
              affected_original_ids
            ),
            HINT = 'Resolve each ambiguity through the approved adjustment/reconciliation workflow, then rerun migration 0034.';
  END IF;
END;
$$;--> statement-breakpoint

DO $$
DECLARE
  affected_contract_ids text;
BEGIN
  WITH completed_transfers AS (
    SELECT transfer.id AS transfer_id,
           transfer.contract_id,
           transfer.status AS transfer_status,
           transfer.approved_by,
           transfer.transferred_at,
           transfer.evidence AS transfer_evidence,
           agreement.status::text AS contract_status,
           agreement.ownership_holder,
           agreement.outstanding_balance_minor_units,
           asset.id AS vehicle_unit_id,
           asset.status::text AS vehicle_status,
           registration.registration_number,
           registration.registered_owner::text AS registered_owner,
           registration.valid_from,
           registration.valid_to,
           registration.evidence_document_id AS registration_evidence_document_id,
           document.id AS evidence_document_id,
           document.document_type,
           document.status::text AS evidence_document_status,
           document.malware_scanned,
           document.sha256 AS evidence_document_sha256,
           document.accepted_object_key,
           document.accepted_object_version_id,
           document.accepted_object_etag,
           accepted_evidence.id AS accepted_evidence_id,
           accepted_evidence.evidence_document_reference,
           accepted_evidence.evidence_hash,
           accepted_evidence.evidence_object_key,
           accepted_evidence.evidence_object_version_id,
           accepted_evidence.evidence_object_etag
      FROM ownership_transfer transfer
      JOIN contract agreement ON agreement.id = transfer.contract_id
      JOIN vehicle_unit asset ON asset.id = agreement.vehicle_unit_id
      LEFT JOIN LATERAL (
        SELECT record.registration_number,
               record.registered_owner,
               record.valid_from,
               record.valid_to,
               record.evidence_document_id
          FROM registration_record record
         WHERE record.vehicle_unit_id = asset.id
         ORDER BY record.created_at DESC, record.id DESC
         LIMIT 1
      ) registration ON true
      LEFT JOIN privacy.document document
        ON document.id::text = transfer.evidence->>'registrationEvidenceDocumentId'
      LEFT JOIN settlement_evidence accepted_evidence
        ON accepted_evidence.contract_id = transfer.contract_id
       AND accepted_evidence.evidence_document_id = document.id
       AND accepted_evidence.verification_status = 'CLEAN'
     WHERE transfer.status = 'COMPLETED'
  ), classified AS (
    SELECT completed_transfers.*,
           (
             transfer_status = 'COMPLETED'
             AND contract_status = 'TRANSFERRED'
             AND ownership_holder = 'CUSTOMER'
             AND outstanding_balance_minor_units = 0
             AND vehicle_status = 'TRANSFERRED'
             AND registered_owner = 'CUSTOMER'
             AND registration_evidence_document_id = evidence_document_id
             AND evidence_document_id IS NOT NULL
             AND transfer_evidence->>'registrationEvidenceDocumentId' =
                 evidence_document_id::text
             AND accepted_evidence_id IS NOT NULL
             AND document_type = 'TRANSFER_EVIDENCE'
             AND evidence_document_status = 'ACCEPTED'
             AND malware_scanned
             AND evidence_document_sha256 ~ '^[0-9a-f]{64}$'
             AND accepted_object_key IS NOT NULL
             AND accepted_object_version_id IS NOT NULL
             AND accepted_object_etag IS NOT NULL
             AND evidence_document_reference = accepted_object_key
             AND evidence_hash = evidence_document_sha256
             AND evidence_object_key = accepted_object_key
             AND evidence_object_version_id = accepted_object_version_id
             AND evidence_object_etag = accepted_object_etag
           ) AS already_coherent,
           (
             transfer_status = 'COMPLETED'
             AND approved_by IS NOT NULL
             AND contract_status = 'SETTLED'
             AND ownership_holder = 'SOMOCO'
             AND outstanding_balance_minor_units = 0
             AND registered_owner = 'SOMOCO'
             AND registration_number IS NOT NULL
             AND valid_from IS NOT NULL
             AND evidence_document_id IS NOT NULL
             AND transfer_evidence->>'registrationEvidenceDocumentId' =
                 evidence_document_id::text
             AND (registration_evidence_document_id IS NULL
                  OR registration_evidence_document_id = evidence_document_id)
             AND accepted_evidence_id IS NOT NULL
             AND document_type = 'TRANSFER_EVIDENCE'
             AND evidence_document_status = 'ACCEPTED'
             AND malware_scanned
             AND evidence_document_sha256 ~ '^[0-9a-f]{64}$'
             AND accepted_object_key IS NOT NULL
             AND accepted_object_version_id IS NOT NULL
             AND accepted_object_etag IS NOT NULL
             AND evidence_document_reference = accepted_object_key
             AND evidence_hash = evidence_document_sha256
             AND evidence_object_key = accepted_object_key
             AND evidence_object_version_id = accepted_object_version_id
             AND evidence_object_etag = accepted_object_etag
           ) AS backfillable
      FROM completed_transfers
  )
  SELECT string_agg(contract_id::text, ', ' ORDER BY contract_id::text)
    INTO affected_contract_ids
    FROM classified
   WHERE NOT already_coherent AND NOT backfillable;

  IF affected_contract_ids IS NOT NULL THEN
    RAISE EXCEPTION 'LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED'
      USING ERRCODE = 'P0001',
            DETAIL = format(
              'Affected contract identifiers: %s.',
              affected_contract_ids
            ),
            HINT = 'Resolve each legacy ownership transfer through the approved reconciliation and evidence workflow, then rerun migration 0034.';
  END IF;
END;
$$;--> statement-breakpoint

WITH derivable_transfers AS (
  SELECT transfer.contract_id,
         agreement.vehicle_unit_id,
         registration.registration_number,
         registration.valid_from,
         registration.valid_to,
         document.id AS evidence_document_id,
         GREATEST(now(), COALESCE(transfer.transferred_at, now())) AS transferred_at
    FROM ownership_transfer transfer
    JOIN contract agreement ON agreement.id = transfer.contract_id
    JOIN vehicle_unit asset ON asset.id = agreement.vehicle_unit_id
    JOIN LATERAL (
      SELECT record.registration_number,
             record.registered_owner,
             record.valid_from,
             record.valid_to,
             record.evidence_document_id
        FROM registration_record record
       WHERE record.vehicle_unit_id = asset.id
       ORDER BY record.created_at DESC, record.id DESC
       LIMIT 1
    ) registration ON true
    JOIN privacy.document document
      ON document.id::text = transfer.evidence->>'registrationEvidenceDocumentId'
    JOIN settlement_evidence accepted_evidence
      ON accepted_evidence.contract_id = transfer.contract_id
     AND accepted_evidence.evidence_document_id = document.id
     AND accepted_evidence.verification_status = 'CLEAN'
   WHERE transfer.status = 'COMPLETED'
     AND transfer.approved_by IS NOT NULL
     AND agreement.status::text = 'SETTLED'
     AND agreement.ownership_holder = 'SOMOCO'
     AND agreement.outstanding_balance_minor_units = 0
     AND asset.id IS NOT NULL
     AND registration.registered_owner = 'SOMOCO'
     AND registration.registration_number IS NOT NULL
     AND registration.valid_from IS NOT NULL
     AND document.document_type = 'TRANSFER_EVIDENCE'
     AND document.status::text = 'ACCEPTED'
     AND document.malware_scanned
     AND document.sha256 ~ '^[0-9a-f]{64}$'
     AND document.accepted_object_key IS NOT NULL
     AND document.accepted_object_version_id IS NOT NULL
     AND document.accepted_object_etag IS NOT NULL
     AND accepted_evidence.evidence_document_reference = document.accepted_object_key
     AND accepted_evidence.evidence_hash = document.sha256
     AND accepted_evidence.evidence_object_key = document.accepted_object_key
     AND accepted_evidence.evidence_object_version_id = document.accepted_object_version_id
     AND accepted_evidence.evidence_object_etag = document.accepted_object_etag
     AND (registration.evidence_document_id IS NULL
          OR registration.evidence_document_id = document.id)
     AND transfer.evidence->>'registrationEvidenceDocumentId' = document.id::text
)
UPDATE contract agreement
   SET status = 'TRANSFERRED',
       ownership_holder = 'CUSTOMER',
       version = version + 1,
       updated_at = derivable_transfers.transferred_at
  FROM derivable_transfers
 WHERE agreement.id = derivable_transfers.contract_id
   AND agreement.status::text = 'SETTLED'
   AND agreement.ownership_holder = 'SOMOCO'
   AND agreement.outstanding_balance_minor_units = 0;--> statement-breakpoint

WITH derivable_transfers AS (
  SELECT agreement.vehicle_unit_id,
         GREATEST(now(), COALESCE(transfer.transferred_at, now())) AS transferred_at
    FROM ownership_transfer transfer
    JOIN contract agreement ON agreement.id = transfer.contract_id
    JOIN vehicle_unit asset ON asset.id = agreement.vehicle_unit_id
    JOIN LATERAL (
      SELECT record.registration_number,
             record.registered_owner,
             record.valid_from,
             record.valid_to,
             record.evidence_document_id
        FROM registration_record record
       WHERE record.vehicle_unit_id = asset.id
       ORDER BY record.created_at DESC, record.id DESC
       LIMIT 1
    ) registration ON true
    JOIN privacy.document document
      ON document.id::text = transfer.evidence->>'registrationEvidenceDocumentId'
    JOIN settlement_evidence accepted_evidence
      ON accepted_evidence.contract_id = transfer.contract_id
     AND accepted_evidence.evidence_document_id = document.id
     AND accepted_evidence.verification_status = 'CLEAN'
   WHERE transfer.status = 'COMPLETED'
     AND transfer.approved_by IS NOT NULL
     AND agreement.status::text = 'TRANSFERRED'
     AND agreement.ownership_holder = 'CUSTOMER'
     AND agreement.outstanding_balance_minor_units = 0
     AND asset.status::text <> 'TRANSFERRED'
     AND registration.registered_owner = 'SOMOCO'
     AND registration.registration_number IS NOT NULL
     AND registration.valid_from IS NOT NULL
     AND document.document_type = 'TRANSFER_EVIDENCE'
     AND document.status::text = 'ACCEPTED'
     AND document.malware_scanned
     AND document.sha256 ~ '^[0-9a-f]{64}$'
     AND document.accepted_object_key IS NOT NULL
     AND document.accepted_object_version_id IS NOT NULL
     AND document.accepted_object_etag IS NOT NULL
     AND accepted_evidence.evidence_document_reference = document.accepted_object_key
     AND accepted_evidence.evidence_hash = document.sha256
     AND accepted_evidence.evidence_object_key = document.accepted_object_key
     AND accepted_evidence.evidence_object_version_id = document.accepted_object_version_id
     AND accepted_evidence.evidence_object_etag = document.accepted_object_etag
     AND (registration.evidence_document_id IS NULL
          OR registration.evidence_document_id = document.id)
     AND transfer.evidence->>'registrationEvidenceDocumentId' = document.id::text
)
UPDATE vehicle_unit asset
   SET status = 'TRANSFERRED',
       version = version + 1,
       updated_at = derivable_transfers.transferred_at
  FROM derivable_transfers
 WHERE asset.id = derivable_transfers.vehicle_unit_id
   AND asset.status::text <> 'TRANSFERRED';--> statement-breakpoint

WITH derivable_transfers AS (
  SELECT agreement.vehicle_unit_id,
         registration.registration_number,
         registration.valid_from,
         registration.valid_to,
         document.id AS evidence_document_id,
         GREATEST(now(), COALESCE(transfer.transferred_at, now())) AS transferred_at
    FROM ownership_transfer transfer
    JOIN contract agreement ON agreement.id = transfer.contract_id
    JOIN vehicle_unit asset ON asset.id = agreement.vehicle_unit_id
    JOIN LATERAL (
      SELECT record.registration_number,
             record.registered_owner,
             record.valid_from,
             record.valid_to,
             record.evidence_document_id
        FROM registration_record record
       WHERE record.vehicle_unit_id = asset.id
       ORDER BY record.created_at DESC, record.id DESC
       LIMIT 1
    ) registration ON true
    JOIN privacy.document document
      ON document.id::text = transfer.evidence->>'registrationEvidenceDocumentId'
    JOIN settlement_evidence accepted_evidence
      ON accepted_evidence.contract_id = transfer.contract_id
     AND accepted_evidence.evidence_document_id = document.id
     AND accepted_evidence.verification_status = 'CLEAN'
   WHERE transfer.status = 'COMPLETED'
     AND transfer.approved_by IS NOT NULL
     AND agreement.status::text = 'TRANSFERRED'
     AND agreement.ownership_holder = 'CUSTOMER'
     AND agreement.outstanding_balance_minor_units = 0
     AND registration.registered_owner = 'SOMOCO'
     AND registration.registration_number IS NOT NULL
     AND registration.valid_from IS NOT NULL
     AND document.document_type = 'TRANSFER_EVIDENCE'
     AND document.status::text = 'ACCEPTED'
     AND document.malware_scanned
     AND document.sha256 ~ '^[0-9a-f]{64}$'
     AND document.accepted_object_key IS NOT NULL
     AND document.accepted_object_version_id IS NOT NULL
     AND document.accepted_object_etag IS NOT NULL
     AND accepted_evidence.evidence_document_reference = document.accepted_object_key
     AND accepted_evidence.evidence_hash = document.sha256
     AND accepted_evidence.evidence_object_key = document.accepted_object_key
     AND accepted_evidence.evidence_object_version_id = document.accepted_object_version_id
     AND accepted_evidence.evidence_object_etag = document.accepted_object_etag
     AND (registration.evidence_document_id IS NULL
          OR registration.evidence_document_id = document.id)
     AND transfer.evidence->>'registrationEvidenceDocumentId' = document.id::text
)
INSERT INTO registration_record
  (vehicle_unit_id, registration_number, registered_owner,
   valid_from, valid_to, evidence_document_id, created_at)
SELECT vehicle_unit_id,
       registration_number,
       'CUSTOMER',
       valid_from,
       valid_to,
       evidence_document_id,
       transferred_at
  FROM derivable_transfers
 WHERE NOT EXISTS (
   SELECT 1
     FROM registration_record existing
    WHERE existing.vehicle_unit_id = derivable_transfers.vehicle_unit_id
      AND existing.registered_owner = 'CUSTOMER'
      AND existing.evidence_document_id = derivable_transfers.evidence_document_id
 );
