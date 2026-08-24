import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  getInternalExecutor,
  getInternalTransaction,
  withTransaction,
  type DatabaseTransaction,
} from "../transaction.js";
import { appendAuditEvent } from "./audit.js";
import { enqueueOutbox } from "../outbox.js";

export const APPLICATION_SIGNATURE_PURPOSE = "CONTRACT_EXECUTION";

export interface ApplicationSignatureActor {
  personId: string;
  sessionId: string;
  requestId: string;
}

export interface RecordApplicationSignatureInput {
  applicationId: string;
  actor: ApplicationSignatureActor;
  idempotencyKey: string;
  signature: string;
  now: Date;
}

export interface ApplicationSignatureRecord {
  id: string;
  applicationId: string;
  personId: string;
  purpose: typeof APPLICATION_SIGNATURE_PURPOSE;
  signatureHash: string;
  signedAt: string;
  replay: boolean;
}

export async function recordApplicationSignature(
  database: Database,
  input: RecordApplicationSignatureInput,
): Promise<ApplicationSignatureRecord> {
  const signatureHash = createHash("sha256")
    .update(input.signature)
    .digest("hex");
  return withTransaction(database, async (tx) => {
    const executor = getInternalTransaction(tx);
    await executor.execute(sql`
      select pg_advisory_xact_lock(
        hashtextextended(concat('application-signature:', ${input.applicationId}::text, ':', ${input.actor.personId}::text), 0)
      )
    `);
    const application = await executor.execute<{
      applicant_person_id: string;
      guarantor_person_id: string | null;
      guarantor_status: string | null;
      offer_id: string | null;
      offer_version_id: string | null;
    }>(sql`
      select a.applicant_person_id,
             gr.guarantor_person_id,
             gr.status as guarantor_status,
             o.id as offer_id,
             o.accepted_version_id as offer_version_id
        from application a
        left join guarantor_relationship gr on gr.application_id = a.id
        left join offer o on o.application_id = a.id and o.status = 'ACCEPTED'
       where a.id = ${input.applicationId}::uuid
       for update of a
    `);
    const row = application.rows[0];
    if (row === undefined) throw new Error("APPLICATION_NOT_FOUND");
    const isApplicant = row.applicant_person_id === input.actor.personId;
    const isGuarantor =
      row.guarantor_person_id === input.actor.personId &&
      row.guarantor_status === "CONFIRMED";
    if (!isApplicant && !isGuarantor)
      throw new Error("SIGNATURE_NOT_AUTHORIZED");
    if (row.offer_id === null || row.offer_version_id === null)
      throw new Error("OFFER_NOT_ACCEPTED");

    const existing = await executor.execute<{
      id: string;
      signed_at: Date | string;
      evidence: Record<string, unknown>;
    }>(sql`
      select id, signed_at, evidence
        from privacy.signature_evidence
       where person_id = ${input.actor.personId}::uuid
         and purpose = ${APPLICATION_SIGNATURE_PURPOSE}
         and evidence->>'applicationId' = ${input.applicationId}
       order by signed_at desc, id desc
       limit 1
       for update
    `);
    const prior = existing.rows[0];
    if (prior !== undefined) {
      if (
        prior.evidence.idempotencyKey !== input.idempotencyKey ||
        prior.evidence.signatureHash !== signatureHash
      )
        throw new Error("SIGNATURE_ALREADY_RECORDED");
      return {
        id: prior.id,
        applicationId: input.applicationId,
        personId: input.actor.personId,
        purpose: APPLICATION_SIGNATURE_PURPOSE,
        signatureHash,
        signedAt: new Date(prior.signed_at).toISOString(),
        replay: true,
      };
    }

    const evidence = {
      applicationId: input.applicationId,
      offerId: row.offer_id,
      offerVersionId: row.offer_version_id,
      idempotencyKey: input.idempotencyKey,
      signatureHash,
    };
    const id = randomUUID();
    const inserted = await executor.execute<{
      id: string;
      signed_at: Date;
    }>(sql`
      insert into privacy.signature_evidence
        (id, person_id, purpose, evidence, signed_at)
      values (
        ${id}::uuid,
        ${input.actor.personId}::uuid,
        ${APPLICATION_SIGNATURE_PURPOSE},
        ${JSON.stringify(evidence)}::jsonb,
        ${input.now}
      )
      returning id, signed_at
    `);
    const saved = inserted.rows[0];
    if (saved === undefined)
      throw new Error("SIGNATURE_EVIDENCE_APPEND_FAILED");
    await appendAuditEvent(tx, {
      aggregateType: "application",
      aggregateId: input.applicationId,
      action: "CUSTOMER_SIGNATURE_RECORDED",
      actorStaffUserId: null,
      actorPersonId: input.actor.personId,
      requestId: input.actor.requestId,
      data: {
        signatureEvidenceId: saved.id,
        purpose: APPLICATION_SIGNATURE_PURPOSE,
        offerId: row.offer_id,
        offerVersionId: row.offer_version_id,
        signatureHash,
      },
      occurredAt: input.now,
    });
    await enqueueOutbox(tx, {
      id: randomUUID(),
      topic: "applications.signature_recorded",
      aggregateType: "application",
      aggregateId: input.applicationId,
      payload: {
        signatureEvidenceId: saved.id,
        personId: input.actor.personId,
        purpose: APPLICATION_SIGNATURE_PURPOSE,
        offerId: row.offer_id,
        offerVersionId: row.offer_version_id,
      },
      occurredAt: input.now,
    });
    return {
      id: saved.id,
      applicationId: input.applicationId,
      personId: input.actor.personId,
      purpose: APPLICATION_SIGNATURE_PURPOSE,
      signatureHash,
      signedAt: new Date(saved.signed_at).toISOString(),
      replay: false,
    };
  });
}

export interface ApplicationSignatureEvidence {
  id: string;
  personId: string;
  signatureHash: string;
  offerId: string;
  offerVersionId: string;
  signedAt: string;
}

export async function findApplicationSignatureEvidence(
  database: Database | DatabaseTransaction,
  applicationId: string,
): Promise<ApplicationSignatureEvidence[]> {
  const result = await getInternalExecutor(database).execute<{
    id: string;
    person_id: string;
    evidence: Record<string, unknown>;
    signed_at: Date | string;
  }>(sql`
    select id, person_id, evidence, signed_at
      from privacy.signature_evidence
     where purpose = ${APPLICATION_SIGNATURE_PURPOSE}
       and evidence->>'applicationId' = ${applicationId}
     order by signed_at asc, id asc
  `);
  return result.rows.flatMap((row) => {
    const signatureHash = row.evidence.signatureHash;
    const offerId = row.evidence.offerId;
    const offerVersionId = row.evidence.offerVersionId;
    if (
      typeof signatureHash !== "string" ||
      typeof offerId !== "string" ||
      typeof offerVersionId !== "string"
    )
      return [];
    return [
      {
        id: row.id,
        personId: row.person_id,
        signatureHash,
        offerId,
        offerVersionId,
        signedAt: new Date(row.signed_at).toISOString(),
      },
    ];
  });
}
