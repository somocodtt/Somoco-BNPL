import { randomUUID } from "node:crypto";
import {
  appendAuditEvent,
  withTransaction,
  type Database,
  type DatabaseTransaction,
} from "@somo/db";
import { sql } from "../../../../../packages/db/node_modules/drizzle-orm/index.js";
import { getInternalDatabase } from "../../../../../packages/db/src/client.js";
import { getInternalExecutor } from "../../../../../packages/db/src/transaction.js";
import { AppError } from "../../plugins/errors.js";
import type {
  PrivacyActor,
  PrivacyCorrection,
  PrivacyRequest,
  PrivacyRequestStatus,
  PrivacyRestriction,
  PrivacyService,
  PrivacyServiceOptions,
  RetentionPolicy,
} from "./service.js";

const durablePrivacyServices = new WeakSet<object>();
const complianceRoles = new Set(["COMPLIANCE_OFFICER", "DPO"]);
const privacyReadRoles = new Set([...complianceRoles, "COMPLIANCE_AUDITOR"]);
const correctionFieldPattern = /^[a-z][A-Za-z0-9_]{0,63}$/;
const immutableFieldPattern =
  /(?:ledger|payment|approval|audit|contract|signature|identity.?check|financial|amount|balance|decision)/i;
const sensitiveKeyPattern =
  /(?:otp|password|secret|token|authorization|cookie|session|mfa|code|private.?key)/i;

export function isDurablePrivacyService(
  service: PrivacyService | undefined,
): service is PrivacyService {
  return service !== undefined && durablePrivacyServices.has(service);
}

export function createPostgresPrivacyService(
  options: PrivacyServiceOptions & { database: Database },
): PrivacyService {
  const now = options.now ?? (() => new Date());
  const subjectData: NonNullable<PrivacyServiceOptions["subjectData"]> =
    options.subjectData ??
    ((subjectId: string): Record<string, unknown> => ({ subjectId }));

  const service: PrivacyService = {
    async openRequest(input) {
      assertSubjectId(input.subjectId);
      if (
        input.subjectType !== "APPLICANT" &&
        input.subjectType !== "GUARANTOR"
      )
        throw privacyError("PRIVACY_SUBJECT_TYPE_INVALID", 400);
      if (!isRequestType(input.requestType))
        throw privacyError("PRIVACY_REQUEST_TYPE_INVALID", 400);
      const id = randomUUID();
      const createdAt = now();
      const requestedBy = input.requestedBy ?? input.subjectId;
      assertSubjectId(requestedBy);
      await withTransaction(options.database, async (tx) => {
        const executor = getInternalExecutor(tx);
        await executor.execute(sql`
          insert into privacy.privacy_request_evidence
            (id, subject_id, subject_type, request_type, requested_by, reason, created_at)
          values (${id}, ${input.subjectId}, ${input.subjectType}, ${input.requestType},
                  ${requestedBy}, ${input.reason?.trim() || null}, ${createdAt})
        `);
        await executor.execute(sql`
          insert into privacy.privacy_request_event
            (request_id, status, actor_id, evidence, occurred_at)
          values (${id}, 'OPEN', ${requestedBy},
                  ${JSON.stringify({ source: "SUBJECT_REQUEST" })}::jsonb,
                  ${createdAt})
        `);
        await audit(tx, {
          aggregateType: "privacy_request",
          aggregateId: id,
          action: "PRIVACY_REQUEST_OPENED",
          actorId: requestedBy,
          data: {
            subjectId: input.subjectId,
            subjectType: input.subjectType,
            requestType: input.requestType,
          },
          occurredAt: createdAt,
        });
      });
      return (await readRequest(options.database, id))!;
    },

    async listRequests(input = {}) {
      if (input.actor !== undefined || input.subjectId === undefined)
        assertPrivacyReadActor(input.actor);
      const result = await getInternalDatabase(options.database)
        .execute<PrivacyRequestRow>(sql`
        select request.id::text, request.subject_id::text,
               request.subject_type, request.request_type,
               request.requested_by::text, request.reason,
               request.created_at,
               latest.status, latest.occurred_at as updated_at
          from privacy.privacy_request_evidence request
          join lateral (
            select event.status, event.occurred_at
              from privacy.privacy_request_event event
             where event.request_id = request.id
             order by event.occurred_at desc, event.id desc limit 1
          ) latest on true
         order by request.created_at, request.id
      `);
      return result.rows
        .map(mapRequest)
        .filter(
          (request) =>
            (input.subjectId === undefined ||
              request.subjectId === input.subjectId) &&
            (input.status === undefined || request.status === input.status),
        );
    },

    async reviewRequest(input) {
      assertComplianceActor(input.actor);
      return appendRequestStatus(
        options.database,
        input.requestId,
        "IN_REVIEW",
        input.actor,
        now(),
      );
    },

    async closeRequest(input) {
      assertComplianceActor(input.actor);
      return appendRequestStatus(
        options.database,
        input.requestId,
        input.outcome ?? "COMPLETED",
        input.actor,
        now(),
      );
    },

    async exportSubjectData(input) {
      const request = await readRequest(options.database, input.requestId);
      if (
        request === null ||
        request.requestType !== "ACCESS" ||
        request.subjectId !== input.subjectId ||
        request.status === "REJECTED" ||
        request.status === "CLOSED"
      )
        throw privacyError("PRIVACY_EXPORT_NOT_AUTHORIZED", 403);
      const executor = getInternalDatabase(options.database);
      const anonymized = await executor.execute<{ occurred_at: Date | string }>(
        sql`
          select occurred_at from privacy.privacy_subject_retention_evidence
           where subject_id = ${input.subjectId} and action = 'ANONYMIZED'
           order by occurred_at desc, id desc limit 1
        `,
      );
      if (anonymized.rows[0] !== undefined)
        return {
          subjectId: input.subjectId,
          profile: {
            anonymized: true,
            anonymizedAt: toIso(anonymized.rows[0].occurred_at),
          },
          restrictions: [],
          corrections: [],
        };
      const restrictions = await listRestrictions(executor, input.subjectId);
      const corrections = await listCorrections(executor, input.subjectId);
      const raw = await subjectData(input.subjectId);
      const profile =
        isRecord(raw.profile) && !Array.isArray(raw.profile)
          ? raw.profile
          : raw;
      return {
        subjectId: input.subjectId,
        profile: redactExport(profile),
        restrictions,
        corrections,
      };
    },

    async recordCorrection(input) {
      assertComplianceActor(input.actor);
      if (!correctionFieldPattern.test(input.field))
        throw privacyError("PRIVACY_CORRECTION_FIELD_INVALID", 400);
      if (immutableFieldPattern.test(input.field))
        throw privacyError("PRIVACY_IMMUTABLE_EVIDENCE", 409);
      const reason = input.reason.trim();
      if (reason === "")
        throw privacyError("PRIVACY_CORRECTION_REASON_REQUIRED", 400);
      return withTransaction(options.database, async (tx) => {
        const request = await readRequest(tx, input.requestId, true);
        if (
          request === null ||
          request.requestType !== "CORRECTION" ||
          request.subjectId !== input.subjectId
        )
          throw privacyError("PRIVACY_CORRECTION_NOT_AUTHORIZED", 403);
        assertRequestMutable(request);
        const executor = getInternalExecutor(tx);
        await executor.execute(sql`
          select pg_advisory_xact_lock(
            hashtextextended(${`${input.subjectId}:${input.field}`}, 7811)
          )
        `);
        const versionResult = await executor.execute<{ version: number }>(sql`
          select (coalesce(max(version), 0) + 1)::int as version
            from privacy.privacy_correction_evidence
           where subject_id = ${input.subjectId} and field = ${input.field}
        `);
        const version = versionResult.rows[0]!.version;
        const id = randomUUID();
        const recordedAt = now();
        const proposedValue = JSON.stringify(
          cloneSafe(input.proposedValue) ?? null,
        );
        await executor.execute(sql`
          insert into privacy.privacy_correction_evidence
            (id, request_id, subject_id, field, proposed_value, reason,
             version, recorded_by, recorded_at)
          values (${id}, ${input.requestId}, ${input.subjectId}, ${input.field},
                  ${proposedValue}::jsonb, ${reason}, ${version},
                  ${input.actor.id}, ${recordedAt})
        `);
        await audit(tx, {
          aggregateType: "privacy_correction",
          aggregateId: id,
          action: "PRIVACY_CORRECTION_RECORDED",
          actorId: input.actor.id,
          data: {
            requestId: input.requestId,
            subjectId: input.subjectId,
            field: input.field,
            version,
            reason,
          },
          occurredAt: recordedAt,
        });
        return {
          id,
          subjectId: input.subjectId,
          field: input.field,
          proposedValue: cloneSafe(input.proposedValue),
          reason,
          version,
          recordedBy: input.actor.id,
          recordedAt: recordedAt.toISOString(),
        };
      });
    },

    async restrictProcessing(input) {
      assertComplianceActor(input.actor);
      const reason = input.reason.trim();
      if (reason === "")
        throw privacyError("PRIVACY_RESTRICTION_REASON_REQUIRED", 400);
      return withTransaction(options.database, async (tx) => {
        const request = await readRequest(tx, input.requestId, true);
        if (
          request === null ||
          request.requestType !== "RESTRICTION" ||
          request.subjectId !== input.subjectId
        )
          throw privacyError("PRIVACY_RESTRICTION_NOT_AUTHORIZED", 403);
        assertRequestMutable(request);
        const id = randomUUID();
        const createdAt = now();
        await getInternalExecutor(tx).execute(sql`
          insert into privacy.privacy_restriction_evidence
            (id, request_id, subject_id, reason, requested_by, created_at)
          values (${id}, ${input.requestId}, ${input.subjectId}, ${reason},
                  ${input.actor.id}, ${createdAt})
        `);
        await audit(tx, {
          aggregateType: "privacy_restriction",
          aggregateId: id,
          action: "PRIVACY_PROCESSING_RESTRICTED",
          actorId: input.actor.id,
          data: {
            requestId: input.requestId,
            subjectId: input.subjectId,
            reason,
          },
          occurredAt: createdAt,
        });
        return {
          id,
          subjectId: input.subjectId,
          reason,
          requestedBy: input.actor.id,
          createdAt: createdAt.toISOString(),
          releasedAt: null,
        };
      });
    },

    async placeLegalHold(input) {
      assertComplianceActor(input.actor);
      assertSubjectId(input.subjectId);
      const reason = input.reason.trim();
      if (reason === "")
        throw privacyError("PRIVACY_LEGAL_HOLD_REASON_REQUIRED", 400);
      const placedAt = now();
      const id = randomUUID();
      await withTransaction(options.database, async (tx) => {
        await getInternalExecutor(tx).execute(sql`
          insert into privacy.privacy_legal_hold_evidence
            (id, subject_id, action, reason, actor_id, occurred_at)
          values (${id}, ${input.subjectId}, 'PLACED', ${reason},
                  ${input.actor.id}, ${placedAt})
        `);
        await audit(tx, {
          aggregateType: "privacy_legal_hold",
          aggregateId: id,
          action: "PRIVACY_LEGAL_HOLD_PLACED",
          actorId: input.actor.id,
          data: { subjectId: input.subjectId, reason },
          occurredAt: placedAt,
        });
      });
      return {
        subjectId: input.subjectId,
        reason,
        placedAt: placedAt.toISOString(),
      };
    },

    async releaseLegalHold(input) {
      assertComplianceActor(input.actor);
      assertSubjectId(input.subjectId);
      const releasedAt = now();
      const id = randomUUID();
      await withTransaction(options.database, async (tx) => {
        await getInternalExecutor(tx).execute(sql`
          insert into privacy.privacy_legal_hold_evidence
            (id, subject_id, action, actor_id, occurred_at)
          values (${id}, ${input.subjectId}, 'RELEASED', ${input.actor.id},
                  ${releasedAt})
        `);
        await audit(tx, {
          aggregateType: "privacy_legal_hold",
          aggregateId: id,
          action: "PRIVACY_LEGAL_HOLD_RELEASED",
          actorId: input.actor.id,
          data: { subjectId: input.subjectId },
          occurredAt: releasedAt,
        });
      });
      return {
        subjectId: input.subjectId,
        releasedAt: releasedAt.toISOString(),
      };
    },

    async approveRetentionPolicy(input) {
      assertComplianceActor(input.actor);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.version))
        throw privacyError("PRIVACY_RETENTION_POLICY_INVALID", 400);
      if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1)
        throw privacyError("PRIVACY_RETENTION_POLICY_INVALID", 400);
      return withTransaction(options.database, async (tx) => {
        const approvedAt = now();
        const inserted = await getInternalExecutor(tx).execute<{
          version: string;
          retention_days: number;
          approved_by: string;
          approved_at: Date | string;
        }>(sql`
          insert into privacy.privacy_retention_policy_evidence
            (version, retention_days, approved_by, approved_at)
          values (${input.version}, ${input.retentionDays}, ${input.actor.id}, ${approvedAt})
          on conflict (version) do nothing
          returning version, retention_days, approved_by::text, approved_at
        `);
        const row =
          inserted.rows[0] ??
          (
            await getInternalExecutor(tx).execute<{
              version: string;
              retention_days: number;
              approved_by: string;
              approved_at: Date | string;
            }>(sql`
              select version, retention_days, approved_by::text, approved_at
                from privacy.privacy_retention_policy_evidence
               where version = ${input.version}
            `)
          ).rows[0];
        if (row === undefined)
          throw new Error("PRIVACY_RETENTION_POLICY_CREATE_FAILED");
        if (row.retention_days !== input.retentionDays)
          throw privacyError("PRIVACY_RETENTION_POLICY_IMMUTABLE", 409);
        if (inserted.rows[0] !== undefined) {
          const auditId = randomUUID();
          await audit(tx, {
            aggregateType: "privacy_retention_policy",
            aggregateId: auditId,
            action: "PRIVACY_RETENTION_POLICY_APPROVED",
            actorId: input.actor.id,
            data: {
              version: input.version,
              retentionDays: input.retentionDays,
            },
            occurredAt: approvedAt,
          });
        }
        return mapPolicy(row);
      });
    },

    async applyRetention(input) {
      assertComplianceActor(input.actor);
      const asOf = input.asOf ?? now();
      return withTransaction(options.database, async (tx) => {
        const executor = getInternalExecutor(tx);
        const policyResult = await executor.execute<{
          version: string;
          retention_days: number;
          approved_by: string;
          approved_at: Date | string;
        }>(sql`
          select version, retention_days, approved_by::text, approved_at
            from privacy.privacy_retention_policy_evidence
           where version = ${input.policyVersion}
           for share
        `);
        const policyRow = policyResult.rows[0];
        if (policyRow === undefined)
          throw privacyError("PRIVACY_RETENTION_POLICY_NOT_APPROVED", 409);
        const subjects = await executor.execute<RetentionSubjectRow>(sql`
          with subject_activity as (
            select id as subject_id, created_at as activity_at from privacy.person
            union all
            select subject_id, created_at from privacy.privacy_request_evidence
            union all
            select subject_id, recorded_at from privacy.privacy_correction_evidence
            union all
            select subject_id, created_at from privacy.privacy_restriction_evidence
          ), latest_hold as (
            select distinct on (subject_id) subject_id, action
              from privacy.privacy_legal_hold_evidence
             order by subject_id, occurred_at desc, id desc
          )
          select activity.subject_id::text,
                 min(activity.activity_at) as created_at,
                 max(activity.activity_at) as latest_activity,
                 coalesce(hold.action = 'PLACED', false) as legal_hold,
                 exists (
                   select 1 from privacy.privacy_subject_retention_evidence retained
                    where retained.subject_id = activity.subject_id
                      and retained.action = 'ANONYMIZED'
                 ) as anonymized
            from subject_activity activity
            left join latest_hold hold on hold.subject_id = activity.subject_id
           group by activity.subject_id, hold.action
           order by activity.subject_id
        `);
        let anonymized = 0;
        let retained = 0;
        let skippedLegalHold = 0;
        for (const subject of subjects.rows) {
          if (subject.legal_hold) {
            skippedLegalHold += 1;
            continue;
          }
          if (
            subject.anonymized ||
            asOf.getTime() - new Date(subject.latest_activity).getTime() <
              policyRow.retention_days * 24 * 60 * 60 * 1_000
          ) {
            retained += 1;
            continue;
          }
          const inserted = await executor.execute<{ id: string }>(sql`
            insert into privacy.privacy_subject_retention_evidence
              (subject_id, policy_version, action, occurred_at)
            values (${subject.subject_id}, ${policyRow.version}, 'ANONYMIZED', ${asOf})
            on conflict (subject_id) where action = 'ANONYMIZED' do nothing
            returning id::text
          `);
          if (inserted.rows[0] === undefined) retained += 1;
          else anonymized += 1;
        }
        const runId = randomUUID();
        const result = {
          policyVersion: policyRow.version,
          evaluated: subjects.rows.length,
          anonymized,
          retained,
          skippedLegalHold,
          immutableEvidenceRetained: subjects.rows.length,
        };
        await executor.execute(sql`
          insert into privacy.privacy_retention_run_evidence
            (id, policy_version, actor_id, as_of, evaluated, anonymized,
             retained, skipped_legal_hold, immutable_evidence_retained, created_at)
          values (${runId}, ${policyRow.version}, ${input.actor.id}, ${asOf},
                  ${result.evaluated}, ${result.anonymized}, ${result.retained},
                  ${result.skippedLegalHold}, ${result.immutableEvidenceRetained},
                  ${now()})
        `);
        await audit(tx, {
          aggregateType: "privacy_retention_run",
          aggregateId: runId,
          action: "PRIVACY_RETENTION_APPLIED",
          actorId: input.actor.id,
          data: result,
          occurredAt: asOf,
        });
        return result;
      });
    },
  };

  durablePrivacyServices.add(service);
  return service;
}

interface PrivacyRequestRow extends Record<string, unknown> {
  id: string;
  subject_id: string;
  subject_type: string;
  request_type: string;
  requested_by: string;
  reason: string | null;
  created_at: Date | string;
  status: string;
  updated_at: Date | string;
}

interface RetentionSubjectRow extends Record<string, unknown> {
  subject_id: string;
  created_at: Date | string;
  latest_activity: Date | string;
  legal_hold: boolean;
  anonymized: boolean;
}

async function readRequest(
  database: Database | DatabaseTransaction,
  requestId: string,
  lock = false,
): Promise<PrivacyRequest | null> {
  const executor = getInternalExecutor(database);
  const suffix = lock ? sql`for update of request` : sql``;
  const result = await executor.execute<PrivacyRequestRow>(sql`
    select request.id::text, request.subject_id::text,
           request.subject_type, request.request_type,
           request.requested_by::text, request.reason, request.created_at,
           latest.status, latest.occurred_at as updated_at
      from privacy.privacy_request_evidence request
      join lateral (
        select event.status, event.occurred_at
          from privacy.privacy_request_event event
         where event.request_id = request.id
         order by event.occurred_at desc, event.id desc limit 1
      ) latest on true
     where request.id = ${requestId}
     ${suffix}
  `);
  return result.rows[0] === undefined ? null : mapRequest(result.rows[0]);
}

async function appendRequestStatus(
  database: Database,
  requestId: string,
  status: "IN_REVIEW" | "COMPLETED" | "REJECTED",
  actor: PrivacyActor,
  occurredAt: Date,
): Promise<PrivacyRequest> {
  return withTransaction(database, async (tx) => {
    const current = await readRequest(tx, requestId, true);
    if (current === null) throw privacyError("PRIVACY_REQUEST_NOT_FOUND", 404);
    assertRequestMutable(current);
    const previousOccurredAt = Date.parse(current.updatedAt);
    const eventOccurredAt = new Date(
      Math.max(occurredAt.getTime(), previousOccurredAt + 1),
    );
    await getInternalExecutor(tx).execute(sql`
      insert into privacy.privacy_request_event
        (request_id, status, actor_id, evidence, occurred_at)
      values (${requestId}, ${status}, ${actor.id},
              ${JSON.stringify({ previousStatus: current.status })}::jsonb,
              ${eventOccurredAt})
    `);
    await audit(tx, {
      aggregateType: "privacy_request",
      aggregateId: requestId,
      action:
        status === "IN_REVIEW"
          ? "PRIVACY_REQUEST_REVIEWED"
          : "PRIVACY_REQUEST_CLOSED",
      actorId: actor.id,
      data: { previousStatus: current.status, status },
      occurredAt: eventOccurredAt,
    });
    return (await readRequest(tx, requestId))!;
  });
}

async function listCorrections(
  executor: ReturnType<typeof getInternalDatabase>,
  subjectId: string,
): Promise<PrivacyCorrection[]> {
  const result = await executor.execute<{
    id: string;
    subject_id: string;
    field: string;
    proposed_value: unknown;
    reason: string;
    version: number;
    recorded_by: string;
    recorded_at: Date | string;
  }>(sql`
    select id::text, subject_id::text, field, proposed_value, reason,
           version, recorded_by::text, recorded_at
      from privacy.privacy_correction_evidence
     where subject_id = ${subjectId}
     order by recorded_at, id
  `);
  return result.rows.map((row) => ({
    id: row.id,
    subjectId: row.subject_id,
    field: row.field,
    proposedValue: row.proposed_value,
    reason: row.reason,
    version: row.version,
    recordedBy: row.recorded_by,
    recordedAt: toIso(row.recorded_at),
  }));
}

async function listRestrictions(
  executor: ReturnType<typeof getInternalDatabase>,
  subjectId: string,
): Promise<PrivacyRestriction[]> {
  const result = await executor.execute<{
    id: string;
    subject_id: string;
    reason: string;
    requested_by: string;
    created_at: Date | string;
    released_at: Date | string | null;
  }>(sql`
    select id::text, subject_id::text, reason, requested_by::text,
           created_at, released_at
      from privacy.privacy_restriction_evidence
     where subject_id = ${subjectId}
     order by created_at, id
  `);
  return result.rows.map((row) => ({
    id: row.id,
    subjectId: row.subject_id,
    reason: row.reason,
    requestedBy: row.requested_by,
    createdAt: toIso(row.created_at),
    releasedAt: row.released_at === null ? null : toIso(row.released_at),
  }));
}

function mapRequest(row: PrivacyRequestRow): PrivacyRequest {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectType: row.subject_type as PrivacyRequest["subjectType"],
    requestType: row.request_type as PrivacyRequest["requestType"],
    status: row.status as PrivacyRequestStatus,
    requestedBy: row.requested_by,
    reason: row.reason,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function mapPolicy(row: {
  version: string;
  retention_days: number;
  approved_by: string;
  approved_at: Date | string;
}): RetentionPolicy {
  return {
    version: row.version,
    retentionDays: row.retention_days,
    approvedBy: row.approved_by,
    approvedAt: toIso(row.approved_at),
  };
}

async function audit(
  tx: DatabaseTransaction,
  input: {
    aggregateType: string;
    aggregateId: string;
    action: string;
    actorId: string;
    data: Record<string, unknown>;
    occurredAt: Date;
  },
): Promise<void> {
  await appendAuditEvent(tx, {
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    action: input.action,
    actorStaffUserId: null,
    actorPersonId: null,
    requestId: null,
    data: { ...input.data, actorId: input.actorId },
    occurredAt: input.occurredAt,
  });
}

function assertRequestMutable(request: PrivacyRequest): void {
  if (["COMPLETED", "REJECTED", "CLOSED"].includes(request.status))
    throw privacyError("PRIVACY_REQUEST_TERMINAL", 409);
}

function assertSubjectId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw privacyError("PRIVACY_SUBJECT_INVALID", 400);
}

function assertComplianceActor(actor: PrivacyActor | undefined): void {
  if (
    actor === undefined ||
    !actor.id.trim() ||
    !complianceRoles.has(actor.role?.toUpperCase() ?? "")
  )
    throw privacyError("PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED", 403);
}

function assertPrivacyReadActor(actor: PrivacyActor | undefined): void {
  if (
    actor === undefined ||
    !actor.id.trim() ||
    !privacyReadRoles.has(actor.role?.toUpperCase() ?? "")
  )
    throw privacyError("PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED", 403);
}

function isRequestType(value: string): boolean {
  return (
    value === "ACCESS" || value === "CORRECTION" || value === "RESTRICTION"
  );
}

function privacyError(code: string, status: number): AppError {
  return new AppError(
    status,
    code,
    "The privacy request could not be processed.",
  );
}

function redactExport(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) continue;
    result[key] = redactExportValue(item);
  }
  return result;
}

function redactExportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactExportValue);
  if (isRecord(value)) return redactExport(value);
  return value;
}

function cloneSafe(value: unknown): unknown {
  if (value === undefined || value === null || typeof value !== "object")
    return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
