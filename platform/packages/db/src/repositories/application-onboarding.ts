import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  getInternalExecutor,
  getInternalTransaction,
  withTransaction,
  type DatabaseTransaction,
} from "../transaction.js";
import { enqueueOutbox } from "../outbox.js";
import { appendAuditEvent } from "./audit.js";

export interface ApplicationActor {
  personId: string;
  sessionId: string;
  requestId: string;
}

export interface ApplicationState {
  id: string;
  applicantPersonId: string;
  vehicleModelId: string | null;
  vehicleModelActive: boolean;
  status: string;
  version: number;
  applicantProfile: Record<string, unknown> | null;
  guarantorPersonId: string | null;
  guarantorStatus: string | null;
  guarantorProfile: Record<string, unknown> | null;
  applicantIdentity: EvidenceIdentity | null;
  guarantorIdentity: EvidenceIdentity | null;
  applicantDocuments: EvidenceDocument[];
  guarantorDocuments: EvidenceDocument[];
}

export interface EvidenceIdentity {
  id: string;
  providerReference: string;
  checkedAt: string;
}

export interface EvidenceDocument {
  id: string;
  documentType: string;
  sha256: string;
  acceptedObjectKey: string;
  acceptedObjectVersionId: string;
  acceptedObjectEtag: string;
}

interface MutationInput {
  actor: ApplicationActor;
  applicationId: string;
  mutationId: string;
  operation: string;
  payloadHash: string;
}

export async function createApplicationDraft(
  database: Database,
  actor: ApplicationActor,
  now: Date,
) {
  return withTransaction(database, async (tx) => {
    const id = randomUUID();
    const result = await getInternalTransaction(tx).execute<CommandResult>(sql`
      insert into application (id, applicant_person_id, status, version, created_at, updated_at)
      values (${id}::uuid, ${actor.personId}::uuid, 'DRAFT', 1, ${now}, ${now})
      returning id, status, version
    `);
    const created = requireRow(result.rows, "APPLICATION_INSERT_FAILED");
    await writeEffects(
      tx,
      actor,
      created.id,
      "APPLICATION_DRAFT_CREATED",
      now,
      {
        topic: "applications.draft_created",
        version: created.version,
      },
    );
    return created;
  });
}

export async function saveApplicantSection(
  database: Database,
  input: MutationInput & {
    expectedVersion: number;
    productId?: string;
    vehicleModelId: string;
    profile: Record<string, unknown>;
    now: Date;
  },
) {
  return withTransaction(database, async (tx) => {
    const prior = await beginMutation<CommandResult>(tx, input);
    if (prior !== null) return prior;
    const current = await lockOwnedApplication(
      tx,
      input.applicationId,
      input.actor.personId,
    );
    assertEditable(current.status);
    if (current.version !== input.expectedVersion)
      throw new Error("VERSION_CONFLICT");
    const model = await getInternalTransaction(tx).execute<{ id: string }>(sql`
      select id from vehicle_model where id = ${input.vehicleModelId}::uuid and active = true
    `);
    if (model.rows.length !== 1) throw new Error("VEHICLE_MODEL_UNAVAILABLE");
    if (input.productId !== undefined) {
      const product = await getInternalTransaction(tx).execute<{
        id: string;
      }>(sql`
        select p.id
          from product p
         where p.id = ${input.productId}::uuid
           and p.vehicle_model_id = ${input.vehicleModelId}::uuid
           and p.status = 'ACTIVE'
      `);
      if (product.rows.length !== 1) throw new Error("PRODUCT_UNAVAILABLE");
    }
    await upsertProfile(tx, input.actor.personId, input.profile, input.now);
    const productAssignment =
      input.productId === undefined
        ? sql`product_id`
        : sql`${input.productId}::uuid`;
    const updatedRows = await getInternalTransaction(tx)
      .execute<CommandResult>(sql`
      update application
         set product_id = ${productAssignment},
             vehicle_model_id = ${input.vehicleModelId}::uuid,
             version = version + 1,
             updated_at = ${input.now}
       where id = ${input.applicationId}::uuid
       returning id, status, version
    `);
    const updated = requireRow(updatedRows.rows, "APPLICATION_UPDATE_FAILED");
    await finishMutation(tx, input, updated, input.now);
    await writeEffects(
      tx,
      input.actor,
      updated.id,
      "APPLICANT_SECTION_SAVED",
      input.now,
      {
        topic: "applications.applicant_saved",
        version: updated.version,
      },
    );
    return updated;
  });
}

export async function createGuarantorInvitation(
  database: Database,
  input: MutationInput & {
    expectedVersion: number;
    invitationId: string;
    guarantorPhoneE164: string;
    tokenHash: string;
    tokenVersion: number;
    derivationKeyId: string;
    expiresAt: Date;
    now: Date;
  },
) {
  return withTransaction(database, async (tx) => {
    const prior = await beginMutation<InvitationResult>(tx, input);
    if (prior !== null) return prior;
    const current = await lockOwnedApplication(
      tx,
      input.applicationId,
      input.actor.personId,
    );
    assertEditable(current.status);
    if (current.version !== input.expectedVersion)
      throw new Error("VERSION_CONFLICT");
    const people = await getInternalTransaction(tx).execute<{ id: string }>(sql`
      insert into privacy.person (phone_e164)
      values (${input.guarantorPhoneE164})
      on conflict (phone_e164) do update set phone_e164 = excluded.phone_e164
      returning id
    `);
    const guarantorPersonId = requireRow(
      people.rows,
      "GUARANTOR_CREATE_FAILED",
    ).id;
    if (guarantorPersonId === input.actor.personId) {
      throw new Error("GUARANTOR_MUST_BE_INDEPENDENT");
    }
    const executor = getInternalTransaction(tx);
    await executor.execute(sql`
      update guarantor_invitation
         set revoked_at = ${input.now}
       where application_id = ${input.applicationId}::uuid
         and claimed_at is null and revoked_at is null
    `);
    const savedRelationship = await executor.execute<RelationshipRow>(sql`
      insert into guarantor_relationship
        (application_id, guarantor_person_id, status, version, invited_at)
      values (${input.applicationId}::uuid, ${guarantorPersonId}::uuid, 'INVITED', 1, ${input.now})
      on conflict (application_id) do update
        set guarantor_person_id = excluded.guarantor_person_id,
            status = 'INVITED', version = guarantor_relationship.version + 1,
            invited_at = excluded.invited_at, confirmed_at = null
      returning version
    `);
    await executor.execute(sql`
      insert into guarantor_invitation
        (id, application_id, guarantor_person_id, token_hash, expires_at, created_at)
      values (${input.invitationId}::uuid, ${input.applicationId}::uuid,
        ${guarantorPersonId}::uuid, ${input.tokenHash}, ${input.expiresAt}, ${input.now})
    `);
    const updatedRows = await executor.execute<CommandResult>(sql`
      update application
         set status = 'AWAITING_GUARANTOR', version = version + 1, updated_at = ${input.now}
       where id = ${input.applicationId}::uuid
       returning id, status, version
    `);
    const updated = requireRow(updatedRows.rows, "APPLICATION_UPDATE_FAILED");
    const relationship = requireRow(
      savedRelationship.rows,
      "GUARANTOR_UPDATE_FAILED",
    );
    const result: InvitationResult = {
      invitationId: input.invitationId,
      applicationVersion: updated.version,
      relationshipVersion: relationship.version,
      expiresAt: input.expiresAt.toISOString(),
    };
    await finishMutation(tx, input, result, input.now);
    await writeEffects(
      tx,
      input.actor,
      updated.id,
      "GUARANTOR_INVITED",
      input.now,
      {
        topic: "applications.guarantor_invited",
        invitationId: input.invitationId,
        tokenVersion: input.tokenVersion,
        derivationKeyId: input.derivationKeyId,
      },
    );
    return result;
  });
}

export async function saveGuarantorSection(
  database: Database,
  input: Omit<MutationInput, "applicationId"> & {
    tokenHash: string;
    expectedVersion: number;
    profile: Record<string, unknown>;
    now: Date;
  },
) {
  return withTransaction(database, async (tx) => {
    const invitation = await lockInvitation(tx, input.tokenHash);
    if (invitation.guarantor_person_id !== input.actor.personId) {
      throw new Error("INVITATION_NOT_FOUND");
    }
    const mutation = { ...input, applicationId: invitation.application_id };
    const prior = await beginMutation<GuarantorSaveResult>(tx, mutation);
    if (prior !== null) return prior;
    if (invitation.revoked_at !== null) throw new Error("INVITATION_NOT_FOUND");
    if (invitation.claimed_at !== null)
      throw new Error("INVITATION_ALREADY_CLAIMED");
    if (asDate(invitation.expires_at).getTime() <= input.now.getTime()) {
      throw new Error("INVITATION_EXPIRED");
    }
    const executor = getInternalTransaction(tx);
    const relationships = await executor.execute<RelationshipRow>(sql`
      select version from guarantor_relationship
       where application_id = ${invitation.application_id}::uuid
         and guarantor_person_id = ${input.actor.personId}::uuid
       for update
    `);
    const relationship = requireRow(relationships.rows, "INVITATION_NOT_FOUND");
    if (relationship.version !== input.expectedVersion)
      throw new Error("VERSION_CONFLICT");
    await upsertProfile(tx, input.actor.personId, input.profile, input.now);
    await executor.execute(sql`
      update guarantor_invitation
         set claimed_by_person_id = ${input.actor.personId}::uuid, claimed_at = ${input.now}
       where id = ${invitation.id}::uuid
    `);
    const savedRelationship = await executor.execute<RelationshipRow>(sql`
      update guarantor_relationship
         set status = 'CONFIRMED', version = version + 1, confirmed_at = ${input.now}
       where application_id = ${invitation.application_id}::uuid
       returning version
    `);
    const application = await executor.execute<CommandResult>(sql`
      update application
         set status = 'READY_TO_SUBMIT', version = version + 1, updated_at = ${input.now}
       where id = ${invitation.application_id}::uuid
       returning id, status, version
    `);
    const updated = requireRow(application.rows, "APPLICATION_UPDATE_FAILED");
    const saved = requireRow(savedRelationship.rows, "GUARANTOR_UPDATE_FAILED");
    const result: GuarantorSaveResult = {
      relationshipVersion: saved.version,
      applicationVersion: updated.version,
      status: updated.status,
    };
    await finishMutation(tx, mutation, result, input.now);
    await writeEffects(
      tx,
      input.actor,
      updated.id,
      "GUARANTOR_SECTION_SAVED",
      input.now,
      {
        topic: "applications.guarantor_saved",
        version: updated.version,
      },
    );
    return result;
  });
}

export async function readOwnedApplicationState(
  database: Database,
  applicationId: string,
  applicantPersonId: string,
): Promise<ApplicationState> {
  const state = await readApplicationState(database, applicationId);
  if (state === null || state.applicantPersonId !== applicantPersonId) {
    throw new Error("APPLICATION_NOT_FOUND");
  }
  return state;
}

export async function readResumableApplication(
  database: Database,
  applicantPersonId: string,
  now: Date,
) {
  const result = await getInternalExecutor(database).execute<ResumableRow>(sql`
    select a.id, a.status, a.version, a.vehicle_model_id,
           coalesce(cp.profile_data, '{}'::jsonb) applicant_profile,
           gr.version relationship_version,
           gi.expires_at invitation_expires_at,
           case
             when gr.status = 'CONFIRMED' then 'CONFIRMED'
             when gr.id is null then 'NOT_INVITED'
             when gi.expires_at <= ${now} then 'EXPIRED'
             else 'INVITED'
           end guarantor_status
      from application a
      left join customer_profile cp on cp.person_id = a.applicant_person_id
      left join guarantor_relationship gr on gr.application_id = a.id
      left join lateral (
        select expires_at
          from guarantor_invitation
         where application_id = a.id and revoked_at is null
         order by created_at desc, id desc
         limit 1
      ) gi on true
     where a.applicant_person_id = ${applicantPersonId}::uuid
       and a.status in ('DRAFT', 'AWAITING_GUARANTOR', 'READY_TO_SUBMIT')
     order by a.updated_at desc, a.id desc
     limit 1
  `);
  const row = result.rows[0];
  if (row === undefined) {
    return {
      draft: null,
      guarantorStatus: "NOT_INVITED" as const,
      guarantorInvitation: {
        status: "NOT_INVITED" as const,
        relationshipVersion: null,
        expiresAt: null,
      },
    };
  }
  return {
    draft: {
      id: row.id,
      status: row.status,
      version: row.version,
      vehicleModelId: row.vehicle_model_id,
      applicantProfile: row.applicant_profile,
    },
    guarantorStatus: row.guarantor_status,
    guarantorInvitation: {
      status: row.guarantor_status,
      relationshipVersion: row.relationship_version,
      expiresAt:
        row.invitation_expires_at === null
          ? null
          : asDate(row.invitation_expires_at).toISOString(),
    },
  };
}

export async function resolveGuarantorInvitation(
  database: Database,
  input: { tokenHash: string; guarantorPersonId: string; now: Date },
) {
  const result = await getInternalExecutor(database)
    .execute<ResolvedInvitationRow>(sql`
    select gi.expires_at, gi.claimed_at, gi.revoked_at,
           gr.status relationship_status, gr.version relationship_version,
           a.version application_version
      from guarantor_invitation gi
      join guarantor_relationship gr
        on gr.application_id = gi.application_id
       and gr.guarantor_person_id = gi.guarantor_person_id
      join application a on a.id = gi.application_id
     where gi.token_hash = ${input.tokenHash}
       and gi.guarantor_person_id = ${input.guarantorPersonId}::uuid
  `);
  const row = requireRow(result.rows, "INVITATION_NOT_FOUND");
  if (row.revoked_at !== null) throw new Error("INVITATION_NOT_FOUND");
  const expiresAt = asDate(row.expires_at);
  const status =
    row.claimed_at !== null || row.relationship_status === "CONFIRMED"
      ? "CONFIRMED"
      : expiresAt.getTime() <= input.now.getTime()
        ? "EXPIRED"
        : "INVITED";
  return {
    status,
    relationshipVersion: row.relationship_version,
    applicationVersion: row.application_version,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function listActiveVehicleModels(database: Database) {
  const result = await getInternalExecutor(database)
    .execute<VehicleModelRow>(sql`
    select id, manufacturer, model_name, model_year
      from vehicle_model where active = true
     order by manufacturer, model_name, model_year, id
  `);
  return result.rows.map((row) => ({
    id: row.id,
    manufacturer: row.manufacturer,
    modelName: row.model_name,
    modelYear: row.model_year,
  }));
}

export async function findGuarantorInvitationDeliveryContext(
  database: Database,
  invitationId: string,
) {
  const result = await getInternalExecutor(database)
    .execute<InvitationDeliveryRow>(sql`
    select p.phone_e164, gi.expires_at, gi.claimed_at, gi.revoked_at
      from guarantor_invitation gi
      join privacy.person p on p.id = gi.guarantor_person_id
     where gi.id = ${invitationId}::uuid
  `);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        phoneE164: row.phone_e164,
        expiresAt: asDate(row.expires_at),
        claimedAt: row.claimed_at === null ? null : asDate(row.claimed_at),
        revokedAt: row.revoked_at === null ? null : asDate(row.revoked_at),
      };
}

export async function submitApplication(
  database: Database,
  input: MutationInput & { expectedVersion: number; now: Date },
  assertComplete: (state: ApplicationState) => void,
) {
  return withTransaction(database, async (tx) => {
    const prior = await beginMutation<CommandResult>(tx, input);
    if (prior !== null) return prior;
    const current = await lockOwnedApplication(
      tx,
      input.applicationId,
      input.actor.personId,
    );
    if (current.version !== input.expectedVersion)
      throw new Error("VERSION_CONFLICT");
    const state = await readApplicationState(tx, input.applicationId);
    if (state === null) throw new Error("APPLICATION_NOT_FOUND");
    assertComplete(state);
    if (state.status !== "READY_TO_SUBMIT")
      throw new Error("APPLICATION_STATE_INVALID");
    const executor = getInternalTransaction(tx);
    const snapshot = buildSnapshot(state);
    await executor.execute(sql`
      insert into application_version
        (application_id, version_number, snapshot, submitted_at)
      values (${state.id}::uuid,
        (select coalesce(max(version_number), 0) + 1 from application_version where application_id = ${state.id}::uuid),
        ${snapshot}, ${input.now})
    `);
    const updatedRows = await executor.execute<CommandResult>(sql`
      update application
         set status = 'VERIFICATION_REVIEW', version = version + 1,
             submitted_at = ${input.now}, updated_at = ${input.now}
       where id = ${state.id}::uuid
       returning id, status, version
    `);
    const updated = requireRow(updatedRows.rows, "APPLICATION_UPDATE_FAILED");
    await finishMutation(tx, input, updated, input.now);
    await writeEffects(
      tx,
      input.actor,
      state.id,
      "APPLICATION_SUBMITTED",
      input.now,
      {
        topic: "applications.submitted",
        version: updated.version,
      },
    );
    return updated;
  });
}

async function readApplicationState(
  capability: Database | DatabaseTransaction,
  applicationId: string,
): Promise<ApplicationState | null> {
  const executor = getInternalExecutor(capability);
  const base = await executor.execute<BaseStateRow>(sql`
    select a.id, a.applicant_person_id, a.vehicle_model_id, a.status, a.version,
           coalesce(vm.active, false) vehicle_model_active,
           ap.profile_data applicant_profile,
           gr.guarantor_person_id, gr.status guarantor_status,
           gp.profile_data guarantor_profile
      from application a
      left join vehicle_model vm on vm.id = a.vehicle_model_id
      left join customer_profile ap on ap.person_id = a.applicant_person_id
      left join guarantor_relationship gr on gr.application_id = a.id
      left join customer_profile gp on gp.person_id = gr.guarantor_person_id
     where a.id = ${applicationId}::uuid
  `);
  const row = base.rows[0];
  if (row === undefined) return null;
  const applicantIdentity = await readIdentity(
    capability,
    row.applicant_person_id,
  );
  const applicantDocuments = await readDocuments(
    capability,
    row.applicant_person_id,
  );
  const guarantorIdentity =
    row.guarantor_person_id === null
      ? null
      : await readIdentity(capability, row.guarantor_person_id);
  const guarantorDocuments =
    row.guarantor_person_id === null
      ? []
      : await readDocuments(capability, row.guarantor_person_id);
  return {
    id: row.id,
    applicantPersonId: row.applicant_person_id,
    vehicleModelId: row.vehicle_model_id,
    vehicleModelActive: row.vehicle_model_active,
    status: row.status,
    version: row.version,
    applicantProfile: row.applicant_profile,
    guarantorPersonId: row.guarantor_person_id,
    guarantorStatus: row.guarantor_status,
    guarantorProfile: row.guarantor_profile,
    applicantIdentity,
    guarantorIdentity,
    applicantDocuments,
    guarantorDocuments,
  };
}

async function readIdentity(
  capability: Database | DatabaseTransaction,
  personId: string,
) {
  const result = await getInternalExecutor(capability).execute<IdentityRow>(sql`
    select id, provider_reference, checked_at
      from privacy.identity_check
     where person_id = ${personId}::uuid and provider = 'NIA' and status = 'VERIFIED'
     order by checked_at desc, created_at desc limit 1
  `);
  const row = result.rows[0];
  return row === undefined
    ? null
    : {
        id: row.id,
        providerReference: row.provider_reference,
        checkedAt: asDate(row.checked_at).toISOString(),
      };
}

async function readDocuments(
  capability: Database | DatabaseTransaction,
  personId: string,
) {
  const result = await getInternalExecutor(capability).execute<DocumentRow>(sql`
    select id, document_type, sha256, accepted_object_key,
           accepted_object_version_id, accepted_object_etag
      from privacy.document
     where person_id = ${personId}::uuid and status = 'ACCEPTED' and malware_scanned = true
     order by document_type, created_at, id
  `);
  return result.rows.map((row) => ({
    id: row.id,
    documentType: row.document_type,
    sha256: row.sha256,
    acceptedObjectKey: row.accepted_object_key,
    acceptedObjectVersionId: row.accepted_object_version_id,
    acceptedObjectEtag: row.accepted_object_etag,
  }));
}

async function lockOwnedApplication(
  tx: DatabaseTransaction,
  id: string,
  personId: string,
) {
  const result = await getInternalTransaction(tx).execute<CommandResult>(sql`
    select id, status, version from application
     where id = ${id}::uuid and applicant_person_id = ${personId}::uuid
     for update
  `);
  return requireRow(result.rows, "APPLICATION_NOT_FOUND");
}

async function lockInvitation(tx: DatabaseTransaction, tokenHash: string) {
  const result = await getInternalTransaction(tx).execute<InvitationRow>(sql`
    select id, application_id, guarantor_person_id, expires_at, claimed_at, revoked_at
      from guarantor_invitation where token_hash = ${tokenHash} for update
  `);
  return requireRow(result.rows, "INVITATION_NOT_FOUND");
}

async function beginMutation<T>(
  tx: DatabaseTransaction,
  input: MutationInput,
): Promise<T | null> {
  const executor = getInternalTransaction(tx);
  await executor.execute(sql`
    select pg_advisory_xact_lock(
      hashtextextended(concat(${input.actor.personId}::text, ':', ${input.mutationId}::text), 0)
    )
  `);
  const result = await executor.execute<MutationRow>(sql`
    select application_id, operation, payload_hash, result
      from application_mutation
     where actor_person_id = ${input.actor.personId}::uuid and mutation_id = ${input.mutationId}::uuid
  `);
  const prior = result.rows[0];
  if (prior === undefined) return null;
  if (
    prior.application_id !== input.applicationId ||
    prior.operation !== input.operation ||
    prior.payload_hash !== input.payloadHash
  ) {
    throw new Error("IDEMPOTENCY_CONFLICT");
  }
  return prior.result as T;
}

async function finishMutation(
  tx: DatabaseTransaction,
  input: MutationInput,
  result: object,
  now: Date,
) {
  await getInternalTransaction(tx).execute(sql`
    insert into application_mutation
      (application_id, actor_person_id, mutation_id, operation, payload_hash, result, created_at)
    values (${input.applicationId}::uuid, ${input.actor.personId}::uuid,
      ${input.mutationId}::uuid, ${input.operation}, ${input.payloadHash}, ${result}, ${now})
  `);
}

async function upsertProfile(
  tx: DatabaseTransaction,
  personId: string,
  profile: Record<string, unknown>,
  now: Date,
) {
  await getInternalTransaction(tx).execute(sql`
    insert into customer_profile (person_id, profile_data, version, created_at, updated_at)
    values (${personId}::uuid, ${profile}, 1, ${now}, ${now})
    on conflict (person_id) do update
      set profile_data = excluded.profile_data,
          version = customer_profile.version + 1,
          updated_at = excluded.updated_at
  `);
}

async function writeEffects(
  tx: DatabaseTransaction,
  actor: ApplicationActor,
  applicationId: string,
  action: string,
  now: Date,
  data: Record<string, unknown> & { topic: string },
) {
  const { topic, ...payload } = data;
  await appendAuditEvent(tx, {
    aggregateType: "application",
    aggregateId: applicationId,
    action,
    requestId: actor.requestId,
    data: {
      ...payload,
      subjectPersonId: actor.personId,
      customerSessionId: actor.sessionId,
    },
    occurredAt: now,
  });
  await enqueueOutbox(tx, {
    id: randomUUID(),
    topic,
    aggregateType: "application",
    aggregateId: applicationId,
    payload: { ...payload, requestId: actor.requestId },
    occurredAt: now,
  });
}

function buildSnapshot(state: ApplicationState): Record<string, unknown> {
  return {
    applicationId: state.id,
    applicantPersonId: state.applicantPersonId,
    guarantorPersonId: state.guarantorPersonId,
    vehicleModelId: state.vehicleModelId,
    applicantProfile: state.applicantProfile,
    guarantorProfile: state.guarantorProfile,
    identityEvidence: {
      applicant: state.applicantIdentity,
      guarantor: state.guarantorIdentity,
    },
    documentEvidence: {
      applicant: state.applicantDocuments,
      guarantor: state.guarantorDocuments,
    },
  };
}

function assertEditable(status: string): void {
  if (!["DRAFT", "AWAITING_GUARANTOR", "READY_TO_SUBMIT"].includes(status)) {
    throw new Error("APPLICATION_STATE_INVALID");
  }
}

function requireRow<T>(rows: T[], code: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(code);
  return row;
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

type SqlRow = Record<string, unknown>;
interface CommandResult extends SqlRow {
  id: string;
  status: string;
  version: number;
}
interface InvitationResult {
  invitationId: string;
  applicationVersion: number;
  relationshipVersion: number;
  expiresAt: string;
}
interface GuarantorSaveResult {
  relationshipVersion: number;
  applicationVersion: number;
  status: string;
}
interface RelationshipRow extends SqlRow {
  version: number;
}
interface MutationRow extends SqlRow {
  application_id: string;
  operation: string;
  payload_hash: string;
  result: unknown;
}
interface InvitationRow extends SqlRow {
  id: string;
  application_id: string;
  guarantor_person_id: string;
  expires_at: Date | string;
  claimed_at: Date | string | null;
  revoked_at: Date | string | null;
}
interface InvitationDeliveryRow extends SqlRow {
  phone_e164: string;
  expires_at: Date | string;
  claimed_at: Date | string | null;
  revoked_at: Date | string | null;
}
interface BaseStateRow extends SqlRow {
  id: string;
  applicant_person_id: string;
  vehicle_model_id: string | null;
  vehicle_model_active: boolean;
  status: string;
  version: number;
  applicant_profile: Record<string, unknown> | null;
  guarantor_person_id: string | null;
  guarantor_status: string | null;
  guarantor_profile: Record<string, unknown> | null;
}
interface IdentityRow extends SqlRow {
  id: string;
  provider_reference: string;
  checked_at: Date | string;
}
interface DocumentRow extends SqlRow {
  id: string;
  document_type: string;
  sha256: string;
  accepted_object_key: string;
  accepted_object_version_id: string;
  accepted_object_etag: string;
}
interface VehicleModelRow extends SqlRow {
  id: string;
  manufacturer: string;
  model_name: string;
  model_year: number;
}
interface ResumableRow extends SqlRow {
  id: string;
  status: string;
  version: number;
  vehicle_model_id: string | null;
  applicant_profile: Record<string, unknown>;
  guarantor_status: "NOT_INVITED" | "INVITED" | "EXPIRED" | "CONFIRMED";
  relationship_version: number | null;
  invitation_expires_at: Date | string | null;
}
interface ResolvedInvitationRow extends SqlRow {
  expires_at: Date | string;
  claimed_at: Date | string | null;
  revoked_at: Date | string | null;
  relationship_status: string;
  relationship_version: number;
  application_version: number;
}
