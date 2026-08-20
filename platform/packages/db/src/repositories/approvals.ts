import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  getInternalExecutor,
  getInternalTransaction,
  type DatabaseTransaction,
  type InternalDatabaseExecutor,
} from "../transaction.js";

export interface LockedApprovalApplication {
  id: string;
  status: string;
  version: number;
  applicantPersonId: string;
}

export interface ApplicationVersionRecord {
  id: string;
  versionNumber: number;
  snapshot: Record<string, unknown>;
}

export interface ApprovalQueueRecord {
  id: string;
  status: string;
  version: number;
  submittedAt: Date | string | null;
  snapshot: Record<string, unknown>;
}

export interface ApprovalDetailRecord extends ApprovalQueueRecord {
  decisions: Array<Record<string, unknown>>;
  underwriting: Array<Record<string, unknown>>;
}

export interface ApprovalDecisionRecord extends Record<string, unknown> {
  id: string;
}

export function approvalRepo(db: Database | DatabaseTransaction) {
  const executor = executorFor(db);

  return {
    async lockApplication(
      applicationId: string,
    ): Promise<LockedApprovalApplication | null> {
      const result = await executor.execute<{
        id: string;
        status: string;
        version: number;
        applicant_person_id: string;
      }>(sql`
        select id, status, version, applicant_person_id
          from application
         where id = ${applicationId}::uuid
         for update
      `);
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            id: row.id,
            status: row.status,
            version: row.version,
            applicantPersonId: row.applicant_person_id,
          };
    },

    async latestVersion(
      applicationId: string,
    ): Promise<ApplicationVersionRecord | null> {
      const result = await executor.execute<{
        id: string;
        version_number: number;
        snapshot: Record<string, unknown>;
      }>(sql`
        select id, version_number, snapshot
          from application_version
         where application_id = ${applicationId}::uuid
         order by version_number desc
         limit 1
      `);
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            id: row.id,
            versionNumber: row.version_number,
            snapshot: row.snapshot,
          };
    },

    async insertDecision(input: {
      applicationVersionId: string;
      stage: string;
      action: string;
      reason: string;
      decidedBy: string;
      decidedAt: Date;
    }): Promise<ApprovalDecisionRecord> {
      const result = await executor.execute<ApprovalDecisionRecord>(sql`
        insert into approval_decision
          (application_version_id, stage, action, reason, decided_by, decided_at)
        values (
          ${input.applicationVersionId}::uuid,
          ${input.stage}::approval_stage,
          ${input.action}::approval_action,
          ${input.reason},
          ${input.decidedBy}::uuid,
          ${input.decidedAt}
        )
        returning id
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("APPROVAL_DECISION_INSERT_FAILED");
      return row;
    },

    async updateApplication(
      applicationId: string,
      expectedVersion: number,
      status: string,
      updatedAt: Date,
    ): Promise<{ id: string; status: string; version: number }> {
      const result = await executor.execute<{
        id: string;
        status: string;
        version: number;
      }>(sql`
        update application
           set status = ${status}::application_status,
               version = version + 1,
               updated_at = ${updatedAt}
         where id = ${applicationId}::uuid
           and version = ${expectedVersion}
         returning id, status, version
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("STALE_VERSION");
      return row;
    },

    async insertApplicationVersion(input: {
      applicationId: string;
      versionNumber: number;
      snapshot: Record<string, unknown>;
      submittedAt: Date;
    }): Promise<{ id: string }> {
      const result = await executor.execute<{ id: string }>(sql`
        insert into application_version
          (application_id, version_number, snapshot, submitted_at)
        values (
          ${input.applicationId}::uuid,
          ${input.versionNumber},
          ${input.snapshot}::jsonb,
          ${input.submittedAt}
        )
        returning id
      `);
      const row = result.rows[0];
      if (row === undefined)
        throw new Error("APPLICATION_VERSION_INSERT_FAILED");
      return row;
    },

    async hasPendingExceptionRequestedBy(
      applicationId: string,
      staffUserId: string,
    ): Promise<boolean> {
      const result = await executor.execute<{ exists: boolean }>(sql`
        select exists(
          select 1
            from exception_request
           where application_id = ${applicationId}::uuid
             and requested_by = ${staffUserId}::uuid
             and status = 'PENDING'
        )
      `);
      return result.rows[0]?.exists ?? false;
    },

    async findManualCheckByIdempotency(
      applicationId: string,
      idempotencyKey: string,
    ): Promise<Record<string, unknown> | null> {
      const result = await executor.execute<{
        assessment: Record<string, unknown>;
      }>(sql`
        select ua.assessment
          from underwriting_assessment ua
          join application_version av on av.id = ua.application_version_id
         where av.application_id = ${applicationId}::uuid
           and ua.assessment->>'kind' = 'MANUAL_CREDIT_BUREAU_CHECK'
           and ua.assessment->>'idempotencyKey' = ${idempotencyKey}
         order by ua.assessed_at desc
         limit 1
      `);
      return result.rows[0]?.assessment ?? null;
    },

    async evidenceDocumentBelongsToApplication(
      applicationId: string,
      evidenceDocumentId: string,
    ): Promise<boolean> {
      const result = await executor.execute<{ exists: boolean }>(sql`
        select exists(
          select 1
            from application a
            join privacy.document d on d.person_id = a.applicant_person_id
           where a.id = ${applicationId}::uuid
             and d.id = ${evidenceDocumentId}::uuid
             and d.document_type = 'CREDIT_BUREAU_REPORT'
             and d.status = 'ACCEPTED'
             and d.malware_scanned = true
             and d.sha256 is not null
             and d.accepted_object_key is not null
             and d.accepted_object_version_id is not null
             and d.accepted_object_etag is not null
        )
      `);
      return result.rows[0]?.exists ?? false;
    },

    async insertUnderwritingAssessment(input: {
      applicationVersionId: string;
      assessment: Record<string, unknown>;
      assessedBy: string;
      assessedAt: Date;
    }): Promise<void> {
      await executor.execute(sql`
        insert into underwriting_assessment
          (application_version_id, assessment, assessed_by, assessed_at)
        values (
          ${input.applicationVersionId}::uuid,
          ${input.assessment}::jsonb,
          ${input.assessedBy}::uuid,
          ${input.assessedAt}
        )
      `);
    },

    async listQueue(
      statuses: readonly string[],
    ): Promise<ApprovalQueueRecord[]> {
      if (statuses.length === 0) return [];
      const result = await getInternalExecutor(db as Database).execute<{
        id: string;
        status: string;
        version: number;
        submitted_at: Date | string | null;
        snapshot: Record<string, unknown>;
      }>(sql`
        select a.id, a.status, a.version, a.submitted_at,
               coalesce((
                 select av.snapshot from application_version av
                  where av.application_id = a.id
                  order by av.version_number desc limit 1
               ), '{}'::jsonb) as snapshot
          from application a
         where a.status in (${sql.join(
           statuses.map((status) => sql`${status}::application_status`),
           sql`, `,
         )})
         order by a.submitted_at nulls last, a.id
      `);
      return result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        version: row.version,
        submittedAt: row.submitted_at,
        snapshot: row.snapshot,
      }));
    },

    async detail(applicationId: string): Promise<ApprovalDetailRecord | null> {
      const publicExecutor = getInternalExecutor(db as Database);
      const base = await publicExecutor.execute<{
        id: string;
        status: string;
        version: number;
        submitted_at: Date | string | null;
        snapshot: Record<string, unknown>;
      }>(sql`
        select a.id, a.status, a.version, a.submitted_at,
               coalesce((
                 select av.snapshot from application_version av
                  where av.application_id = a.id
                  order by av.version_number desc limit 1
               ), '{}'::jsonb) as snapshot
          from application a
         where a.id = ${applicationId}::uuid
      `);
      const row = base.rows[0];
      if (row === undefined) return null;
      const decisions = await publicExecutor.execute<Record<string, unknown>>(
        sql`
          select d.stage, d.action, d.reason, d.decided_by as "decidedBy",
                 d.decided_at as "decidedAt", av.version_number as "versionNumber"
            from approval_decision d
            join application_version av on av.id = d.application_version_id
           where av.application_id = ${applicationId}::uuid
           order by d.decided_at, d.id
        `,
      );
      const underwriting = await publicExecutor.execute<
        Record<string, unknown>
      >(sql`
        select ua.assessment, ua.assessed_by as "assessedBy",
               ua.assessed_at as "assessedAt", av.version_number as "versionNumber"
          from underwriting_assessment ua
          join application_version av on av.id = ua.application_version_id
         where av.application_id = ${applicationId}::uuid
         order by ua.assessed_at, ua.id
      `);
      return {
        id: row.id,
        status: row.status,
        version: row.version,
        submittedAt: row.submitted_at,
        snapshot: row.snapshot,
        decisions: decisions.rows,
        underwriting: underwriting.rows,
      };
    },
  };
}

function executorFor(
  db: Database | DatabaseTransaction,
): InternalDatabaseExecutor {
  try {
    return getInternalTransaction(db as DatabaseTransaction);
  } catch {
    return getInternalExecutor(db as Database);
  }
}
