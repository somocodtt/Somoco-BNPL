import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../../../../packages/db/node_modules/drizzle-orm/index.js";
import { enqueueOutbox, withTransaction, type Database } from "@somo/db";
import { getInternalDatabase } from "../../../../../packages/db/src/client.js";
import {
  reportExport,
  reportExportEvent,
} from "../../../../../packages/db/src/schema/reports.js";
import { getInternalExecutor } from "../../../../../packages/db/src/transaction.js";
import type { StaffPrincipal } from "../access/policy.js";
import { AppError } from "../../plugins/errors.js";

export type ReportName = "operations" | "portfolio" | "audit" | "migration";
export type ReportFormat = "CSV" | "JSON";
export type ReportClassification = "REDACTED" | "PERSONAL_DATA";

export interface ReportFilters {
  status?: string;
  asOfDate?: string;
  includePersonalData?: boolean;
  staffUserId?: string;
  [key: string]: unknown;
}

export interface ReportResult {
  report: ReportName;
  generatedAt: string;
  dataClassification: ReportClassification;
  filters: Record<string, unknown>;
  rows: readonly Record<string, unknown>[];
  rowCount: number;
  pagination: {
    limit: number;
    truncated: boolean;
    nextCursor: string | null;
  };
  migrationTotals: {
    batches: number;
    records: number;
    quarantined: number;
    imported: number;
  };
  summary: Record<string, string | number>;
}

export interface ReportExportResult {
  id: string;
  report: ReportName;
  format: ReportFormat;
  dataClassification: ReportClassification;
  requesterStaffUserId: string;
  requestId: string;
  rowCount: number;
  contentHash: string;
  watermark: string;
  content: string;
  status: "QUEUED" | "READY" | "FAILED";
}

export interface ReportService {
  operations(input: {
    actor: StaffPrincipal;
    filters?: ReportFilters;
  }): Promise<ReportResult>;
  portfolio(input: {
    actor: StaffPrincipal;
    filters?: ReportFilters;
  }): Promise<ReportResult>;
  audit(input: {
    actor: StaffPrincipal;
    filters?: ReportFilters;
  }): Promise<ReportResult>;
  migration(input: {
    actor: StaffPrincipal;
    filters?: ReportFilters;
  }): Promise<ReportResult>;
  export(input: {
    actor: StaffPrincipal;
    requestId: string;
    report: ReportName;
    filters?: ReportFilters;
    format: ReportFormat;
  }): Promise<ReportExportResult>;
  getExport(input: {
    actor: StaffPrincipal;
    exportId: string;
  }): Promise<ReportExportResult | null>;
}

const OPERATIONAL_ROLES = new Set([
  "SYSTEM_ADMIN",
  "VERIFICATION_OFFICER",
  "BSM",
  "AGM",
  "CFO",
  "MD",
  "FINANCE_OFFICER",
  "RECOVERY_OFFICER",
  "COMPLIANCE_AUDITOR",
  "CUSTOMER_SUPPORT",
]);
const PERSONAL_DATA_ROLES = new Set(["CFO", "MD", "COMPLIANCE_AUDITOR"]);
const INLINE_EXPORT_ROW_LIMIT = 500;
const REPORT_PAGE_LIMIT = 1000;

export function createReportService(options: {
  database: Database;
}): ReportService {
  async function read(
    actor: StaffPrincipal,
    report: ReportName,
    filters: ReportFilters = {},
  ): Promise<ReportResult> {
    requireReportRead(actor, report);
    const dataClassification = classify(actor, filters);
    const internal = getInternalDatabase(options.database);
    const safeFilters = sanitizeFilters(filters);
    const asOfDate = asOfDateFilter(safeFilters);
    const rows =
      report === "operations"
        ? await listOperations(internal, safeFilters, dataClassification)
        : report === "portfolio"
          ? await listPortfolio(internal, safeFilters, dataClassification)
          : report === "audit"
            ? await listAudit(internal, safeFilters, dataClassification)
            : await listMigration(internal, safeFilters);
    const migrationTotals = await getMigrationTotals(internal, asOfDate);
    const truncated = rows.length === REPORT_PAGE_LIMIT;
    const lastRow = rows.at(-1);
    const nextCursor = truncated
      ? String(
          lastRow?.applicationId ??
            lastRow?.contractId ??
            lastRow?.id ??
            lastRow?.batchId ??
            "",
        )
      : null;
    return {
      report,
      generatedAt: new Date().toISOString(),
      dataClassification,
      filters: safeFilters,
      rows,
      rowCount: rows.length,
      pagination: {
        limit: REPORT_PAGE_LIMIT,
        truncated,
        nextCursor,
      },
      migrationTotals,
      summary: summarize(report, rows, migrationTotals),
    };
  }

  return {
    operations: (input) => read(input.actor, "operations", input.filters),
    portfolio: (input) => read(input.actor, "portfolio", input.filters),
    audit: (input) => read(input.actor, "audit", input.filters),
    migration: (input) => read(input.actor, "migration", input.filters),
    async export(input) {
      requireReportRead(input.actor, input.report);
      const filters = input.filters ?? {};
      const report = await read(input.actor, input.report, filters);
      if (
        filters.includePersonalData === true &&
        !canViewPersonalData(input.actor)
      ) {
        throw new AppError(
          403,
          "REPORT_PERSONAL_DATA_FORBIDDEN",
          "This role cannot export personal data.",
        );
      }
      const content =
        input.format === "CSV"
          ? serializeCsv(report.rows)
          : JSON.stringify({
              report: report.report,
              generatedAt: report.generatedAt,
              dataClassification: report.dataClassification,
              rows: report.rows,
            });
      const contentHash = sha256(content);
      const watermark = `SOMOCO CONFIDENTIAL | requester=${input.actor.staffUserId} | request=${input.requestId} | classification=${report.dataClassification}`;
      const status =
        report.rowCount > INLINE_EXPORT_ROW_LIMIT ? "QUEUED" : "READY";
      const artifact = {
        watermark,
        generatedAt: report.generatedAt,
        contentHash,
        format: input.format,
        noRawDocumentUrls: true,
        ...(status === "READY" ? { content } : {}),
      };
      const id = randomUUID();
      await withTransaction(options.database, async (tx) => {
        const executor = getInternalExecutor(tx);
        await executor.insert(reportExport).values({
          id,
          requesterStaffUserId: input.actor.staffUserId,
          requestId: input.requestId,
          reportType: report.report.toUpperCase() as
            "OPERATIONS" | "PORTFOLIO" | "AUDIT" | "MIGRATION",
          format: input.format,
          dataClassification: report.dataClassification,
          filters: report.filters,
          rowCount: report.rowCount,
          contentHash,
          artifact,
          status,
        });
        await executor.insert(reportExportEvent).values({
          id: randomUUID(),
          reportExportId: id,
          eventKey: `report-export:${id}:${status === "QUEUED" ? "QUEUED" : "READY"}`,
          eventType: status,
          contentHash,
          artifact: {
            watermark,
            generatedAt: report.generatedAt,
            format: input.format,
            noRawDocumentUrls: true,
            ...(status === "READY" ? { content } : {}),
          },
        });
        if (status === "QUEUED") {
          await enqueueOutbox(tx, {
            id: randomUUID(),
            topic: "report.export.requested",
            aggregateType: "report_export",
            aggregateId: id,
            occurredAt: new Date(),
            payload: {
              exportId: id,
              report: report.report,
              format: input.format,
              filters: report.filters,
              requesterStaffUserId: input.actor.staffUserId,
              requestId: input.requestId,
              dataClassification: report.dataClassification,
              expectedRowCount: report.rowCount,
              expectedContentHash: contentHash,
              watermark,
              content,
            },
          });
        }
        await executor.execute(sql`
          insert into audit_event
            (aggregate_type, aggregate_id, action, actor_staff_user_id,
             request_id, data, occurred_at)
          values
            ('report_export', ${id}, ${status === "QUEUED" ? "REPORT_EXPORT_QUEUED" : "REPORT_EXPORT_GENERATED"},
             ${input.actor.staffUserId}, ${input.requestId},
             ${JSON.stringify({
               report: report.report,
               format: input.format,
               dataClassification: report.dataClassification,
               rowCount: report.rowCount,
               contentHash,
               filters: report.filters,
             })}::jsonb, now())
        `);
      });
      return {
        id,
        report: report.report,
        format: input.format,
        dataClassification: report.dataClassification,
        requesterStaffUserId: input.actor.staffUserId,
        requestId: input.requestId,
        rowCount: report.rowCount,
        contentHash,
        watermark,
        content: status === "READY" ? content : "",
        status,
      };
    },
    async getExport(input) {
      requireReportRead(input.actor, "operations");
      const internal = getInternalDatabase(options.database);
      const result = await internal.execute<{
        id: string;
        requester_staff_user_id: string;
        request_id: string;
        report_type: string;
        format: ReportFormat;
        data_classification: ReportClassification;
        row_count: number;
        content_hash: string;
        artifact: Record<string, unknown>;
        status: "QUEUED" | "READY" | "FAILED";
      }>(sql`
        select id, requester_staff_user_id, request_id, report_type, format,
               data_classification, row_count, content_hash, artifact, status
          from report_export
         where id = ${input.exportId}
         limit 1
      `);
      const row = result.rows[0];
      if (row === undefined) return null;
      if (
        row.requester_staff_user_id !== input.actor.staffUserId &&
        !canViewPersonalData(input.actor)
      )
        throw new AppError(
          403,
          "REPORT_EXPORT_FORBIDDEN",
          "This export is not available to the staff role.",
        );
      const eventResult = await internal.execute<{
        event_type: "QUEUED" | "READY" | "FAILED";
        content_hash: string | null;
        artifact: Record<string, unknown>;
      }>(sql`
        select event_type, content_hash, artifact
          from report_export_event
         where report_export_id = ${input.exportId}
         order by created_at desc, id desc
         limit 1
      `);
      const event = eventResult.rows[0];
      const artifact = event?.artifact ?? row.artifact;
      return {
        id: row.id,
        report: row.report_type.toLowerCase() as ReportName,
        format: row.format,
        dataClassification: row.data_classification,
        requesterStaffUserId: row.requester_staff_user_id,
        requestId: row.request_id,
        rowCount: row.row_count,
        contentHash: event?.content_hash ?? row.content_hash,
        watermark: String(artifact.watermark ?? ""),
        content: typeof artifact.content === "string" ? artifact.content : "",
        status: event?.event_type ?? row.status,
      };
    },
  };
}

function requireReportRead(actor: StaffPrincipal, report: ReportName): void {
  const permitted =
    report === "audit"
      ? new Set(["SYSTEM_ADMIN", "CFO", "MD", "COMPLIANCE_AUDITOR"])
      : report === "migration"
        ? new Set([
            "SYSTEM_ADMIN",
            "CFO",
            "FINANCE_OFFICER",
            "VERIFICATION_OFFICER",
            "MIGRATION_IMPORTER",
            "COMPLIANCE_AUDITOR",
          ])
        : OPERATIONAL_ROLES;
  if (
    actor.kind !== "staff" ||
    !actor.roles.some((role) => permitted.has(role))
  )
    throw new AppError(
      403,
      "FORBIDDEN",
      "Reporting access is not permitted for this role.",
    );
}

function canViewPersonalData(actor: StaffPrincipal): boolean {
  return actor.roles.some((role) => PERSONAL_DATA_ROLES.has(role));
}

function classify(
  actor: StaffPrincipal,
  filters: ReportFilters,
): ReportClassification {
  if (filters.includePersonalData === true) {
    if (!canViewPersonalData(actor))
      throw new AppError(
        403,
        "REPORT_PERSONAL_DATA_FORBIDDEN",
        "This role cannot view personal data.",
      );
    return "PERSONAL_DATA";
  }
  return "REDACTED";
}

function sanitizeFilters(filters: ReportFilters): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filters)) {
    if (key === "staffUserId" || key === "includePersonalData") continue;
    if (typeof value === "string") safe[key] = value.slice(0, 128);
    else if (typeof value === "number" || typeof value === "boolean")
      safe[key] = value;
  }
  return safe;
}

async function listOperations(
  db: ReturnType<typeof getInternalDatabase>,
  filters: Record<string, unknown>,
  classification: ReportClassification,
): Promise<readonly Record<string, unknown>[]> {
  const status = typeof filters.status === "string" ? filters.status : null;
  const statusClause =
    status === null ? sql`true` : sql`a.status::text = ${status}`;
  const asOfDate = asOfDateFilter(filters);
  const applicationAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`a.created_at < (${asOfDate}::date + interval '1 day')`;
  const identityCheckAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`i.created_at < (${asOfDate}::date + interval '1 day')`;
  const offerAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`o.created_at < (${asOfDate}::date + interval '1 day')`;
  const depositAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`dr.created_at < (${asOfDate}::date + interval '1 day')`;
  const paymentAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`p.created_at < (${asOfDate}::date + interval '1 day')`;
  const paymentContractAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`pc.created_at < (${asOfDate}::date + interval '1 day')`;
  const contractAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`c.created_at < (${asOfDate}::date + interval '1 day')`;
  const vehicleAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`vu.created_at < (${asOfDate}::date + interval '1 day')`;
  const recoveryAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`r.opened_at < (${asOfDate}::date + interval '1 day')`;
  const reconciliationAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`rc.created_at < (${asOfDate}::date + interval '1 day')`;
  const snapshotClause =
    asOfDate === null ? sql`true` : sql`x.as_of_date <= ${asOfDate}::date`;
  const result = await db.execute<{
    id: string;
    status: string;
    created_at: Date;
    submitted_at: Date | null;
    applicant_person_id: string;
    nia_exceptions: number;
    offer_awaiting_deposit: boolean;
    payment_state: string;
    contract_state: string;
    balance: bigint | string | null;
    vehicle_state: string | null;
    consecutive_missed: number;
    total_unpaid: number;
    recovery_cases: number;
    integration_exceptions: number;
  }>(sql`
    select a.id, a.status, a.created_at, a.submitted_at,
           a.applicant_person_id,
           (select count(*)::int from privacy.identity_check i
             where i.person_id = a.applicant_person_id
               and ${identityCheckAsOfClause}
               and i.status in ('FAILED', 'MANUAL_REVIEW')) as nia_exceptions,
           exists(select 1 from offer o
                    where o.application_id = a.id
                      and ${offerAsOfClause}
                      and o.status in ('PENDING', 'ACCEPTED')
                      and not exists (
                        select 1 from deposit_reconciliation dr
                         where dr.application_id = a.id
                           and dr.offer_id = o.id
                           and ${depositAsOfClause}
                           and dr.status = 'RECONCILED'
                      )) as offer_awaiting_deposit,
           case when exists(select 1 from payment_transaction p
                              join contract pc on pc.id = p.contract_id
                             where pc.application_id = a.id
                               and ${paymentAsOfClause}
                               and ${paymentContractAsOfClause}
                               and p.status = 'RECEIVED')
                then 'RECEIVED' else 'NONE' end as payment_state,
           coalesce((select c.status::text from contract c where c.application_id = a.id and ${contractAsOfClause} limit 1), 'NONE') as contract_state,
           (select c.outstanding_balance_minor_units from contract c where c.application_id = a.id and ${contractAsOfClause} limit 1) as balance,
           (select vu.status::text from vehicle_unit vu join contract c on c.vehicle_unit_id = vu.id where c.application_id = a.id and ${contractAsOfClause} and ${vehicleAsOfClause} limit 1) as vehicle_state,
           coalesce((select max(x.consecutive_missed_installments)::int from arrears_snapshot x join contract c on c.id = x.contract_id where c.application_id = a.id and ${snapshotClause}), 0) as consecutive_missed,
           coalesce((select max(x.unpaid_installments)::int from arrears_snapshot x join contract c on c.id = x.contract_id where c.application_id = a.id and ${snapshotClause}), 0) as total_unpaid,
           (select count(*)::int from recovery_case r join contract c on c.id = r.contract_id where c.application_id = a.id and ${recoveryAsOfClause} and ${contractAsOfClause} and r.status <> 'CLOSED') as recovery_cases,
           (select count(*)::int from reconciliation_case rc join payment_transaction p on p.id = rc.payment_transaction_id join contract c on c.id = p.contract_id where c.application_id = a.id and ${reconciliationAsOfClause} and ${paymentAsOfClause} and ${contractAsOfClause} and rc.status <> 'RESOLVED') as integration_exceptions
      from application a
     where ${statusClause} and ${applicationAsOfClause}
     order by a.created_at asc, a.id asc
     limit 1000
  `);
  return result.rows.map((row) => {
    const base: Record<string, unknown> = {
      applicationId: row.id,
      status: row.status,
      stageAgeSeconds: Math.max(
        0,
        Math.floor((Date.now() - new Date(row.created_at).getTime()) / 1000),
      ),
      turnaroundSeconds:
        row.submitted_at === null
          ? null
          : Math.max(
              0,
              Math.floor(
                (Date.now() - new Date(row.submitted_at).getTime()) / 1000,
              ),
            ),
      niaExceptions: row.nia_exceptions,
      offerAwaitingReconciledDeposit: row.offer_awaiting_deposit,
      paymentState: row.payment_state,
      contractState: row.contract_state,
      currentBalanceMinorUnits:
        row.balance === null ? null : String(row.balance),
      vehicleState: row.vehicle_state,
      consecutiveMissed: row.consecutive_missed,
      totalUnpaid: row.total_unpaid,
      recoveryCases: row.recovery_cases,
      integrationExceptions: row.integration_exceptions,
    };
    if (classification === "PERSONAL_DATA")
      base.applicantPersonId = row.applicant_person_id;
    else base.applicantReference = maskedReference(row.applicant_person_id);
    return base;
  });
}

async function listPortfolio(
  db: ReturnType<typeof getInternalDatabase>,
  filters: Record<string, unknown>,
  classification: ReportClassification,
): Promise<readonly Record<string, unknown>[]> {
  const statusClause =
    typeof filters.status === "string"
      ? sql`c.status::text = ${filters.status}`
      : sql`true`;
  const asOfDate = asOfDateFilter(filters);
  const asOfClause =
    asOfDate === null
      ? sql`true`
      : sql`c.created_at < (${asOfDate}::date + interval '1 day')`;
  const vehicleAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`vu.created_at < (${asOfDate}::date + interval '1 day')`;
  const identityCheckAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`i.created_at < (${asOfDate}::date + interval '1 day')`;
  const applicationAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`ia.created_at < (${asOfDate}::date + interval '1 day')`;
  const offerAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`o.created_at < (${asOfDate}::date + interval '1 day')`;
  const depositAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`dr.created_at < (${asOfDate}::date + interval '1 day')`;
  const recoveryAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`r.opened_at < (${asOfDate}::date + interval '1 day')`;
  const reconciliationAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`rc.created_at < (${asOfDate}::date + interval '1 day')`;
  const paymentAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`p.created_at < (${asOfDate}::date + interval '1 day')`;
  const snapshotClause =
    asOfDate === null ? sql`true` : sql`a.as_of_date <= ${asOfDate}::date`;
  const result = await db.execute<{
    id: string;
    reference: string;
    status: string;
    balance: bigint | string;
    ownership_holder: string;
    vehicle_status: string;
    consecutive_missed: number;
    total_unpaid: number;
    nia_exceptions: number;
    deposit_exceptions: number;
    recovery_cases: number;
    integration_exceptions: number;
  }>(sql`
    select c.id, c.reference, c.status, c.outstanding_balance_minor_units as balance,
           c.ownership_holder, vu.status::text as vehicle_status,
           coalesce((select max(a.consecutive_missed_installments)::int from arrears_snapshot a where a.contract_id = c.id and ${snapshotClause}), 0) as consecutive_missed,
           coalesce((select max(a.unpaid_installments)::int from arrears_snapshot a where a.contract_id = c.id and ${snapshotClause}), 0) as total_unpaid,
           coalesce((select count(*)::int from privacy.identity_check i
                      join application ia on ia.applicant_person_id = i.person_id
                     where ia.id = c.application_id
                       and ${applicationAsOfClause}
                       and ${identityCheckAsOfClause}
                       and i.status in ('FAILED', 'MANUAL_REVIEW')), 0) as nia_exceptions,
           coalesce((select count(*)::int from offer o
                      where o.application_id = c.application_id
                        and ${offerAsOfClause}
                        and o.status in ('PENDING', 'ACCEPTED')
                        and not exists (
                          select 1 from deposit_reconciliation dr
                           where dr.application_id = o.application_id
                             and dr.offer_id = o.id
                             and ${depositAsOfClause}
                             and dr.status = 'RECONCILED')), 0) as deposit_exceptions,
           coalesce((select count(*)::int from recovery_case r
                      where r.contract_id = c.id
                        and ${recoveryAsOfClause}
                        and r.status <> 'CLOSED'), 0) as recovery_cases,
           coalesce((select count(*)::int from reconciliation_case rc
                      join payment_transaction p on p.id = rc.payment_transaction_id
                     where p.contract_id = c.id
                       and ${reconciliationAsOfClause}
                       and ${paymentAsOfClause}
                       and rc.status <> 'RESOLVED'), 0) as integration_exceptions
      from contract c join vehicle_unit vu on vu.id = c.vehicle_unit_id and ${vehicleAsOfClause}
     where ${statusClause} and ${asOfClause}
     order by c.created_at asc, c.id asc limit 1000
  `);
  return result.rows.map((row) => ({
    contractId: row.id,
    contractReference: row.reference,
    status: row.status,
    currentBalanceMinorUnits: String(row.balance),
    ownershipHolder: row.ownership_holder,
    vehicleState: row.vehicle_status,
    consecutiveMissed: row.consecutive_missed,
    totalUnpaid: row.total_unpaid,
    niaExceptions: row.nia_exceptions,
    depositReconciliationExceptions: row.deposit_exceptions,
    recoveryCases: row.recovery_cases,
    integrationExceptions: row.integration_exceptions,
    accountReference:
      classification === "PERSONAL_DATA"
        ? row.reference
        : maskedReference(row.reference),
  }));
}

async function listAudit(
  db: ReturnType<typeof getInternalDatabase>,
  filters: Record<string, unknown>,
  classification: ReportClassification,
): Promise<readonly Record<string, unknown>[]> {
  const asOfDate = asOfDateFilter(filters);
  const asOfClause =
    asOfDate === null
      ? sql`true`
      : sql`occurred_at < (${asOfDate}::date + interval '1 day')`;
  const result = await db.execute<{
    id: string;
    aggregate_type: string;
    action: string;
    actor_staff_user_id: string | null;
    request_id: string | null;
    occurred_at: Date;
    data: unknown;
  }>(sql`
    select id, aggregate_type, action, actor_staff_user_id, request_id,
           occurred_at, data
      from audit_event
     where ${asOfClause}
     order by occurred_at desc, id desc limit 1000
  `);
  return result.rows.map((row) => ({
    id: classification === "PERSONAL_DATA" ? row.id : maskedReference(row.id),
    aggregateType: row.aggregate_type,
    action: row.action,
    actorStaffUserId:
      classification === "PERSONAL_DATA" || row.actor_staff_user_id === null
        ? row.actor_staff_user_id
        : maskedReference(row.actor_staff_user_id),
    requestId:
      classification === "PERSONAL_DATA" || row.request_id === null
        ? row.request_id
        : maskedReference(row.request_id),
    occurredAt: new Date(row.occurred_at).toISOString(),
    data: safeAuditData(row.data),
  }));
}

async function listMigration(
  db: ReturnType<typeof getInternalDatabase>,
  filters: Record<string, unknown>,
): Promise<readonly Record<string, unknown>[]> {
  const asOfDate = asOfDateFilter(filters);
  const asOfClause =
    asOfDate === null
      ? sql`true`
      : sql`created_at < (${asOfDate}::date + interval '1 day')`;
  const result = await db.execute<{
    id: string;
    source: string;
    source_batch_id: string;
    status: string;
    expected_records: number;
    imported_records: number;
    expected_total_minor_units: bigint | string;
    reconciled_total_minor_units: bigint | string;
    sample_required: number;
    sample_passed: number;
    created_at: Date;
    verified_by: string | null;
    approved_by: string | null;
    activated_at: Date | null;
  }>(sql`
      select id, source, source_batch_id, status, expected_records,
           imported_records, expected_total_minor_units,
           reconciled_total_minor_units, sample_required, sample_passed,
           created_at, verified_by, approved_by, activated_at
      from migration_batch
     where ${asOfClause}
     order by created_at desc, id desc limit 1000
  `);
  return result.rows.map((row) => ({
    batchId: row.id,
    source: row.source,
    sourceBatchId: row.source_batch_id,
    status: row.status,
    expectedRecords: row.expected_records,
    importedRecords: row.imported_records,
    expectedTotalMinorUnits: String(row.expected_total_minor_units),
    reconciledTotalMinorUnits: String(row.reconciled_total_minor_units),
    sampleRequired: row.sample_required,
    samplePassed: row.sample_passed,
    verifiedBy: row.verified_by,
    approvedBy: row.approved_by,
    activatedAt:
      row.activated_at === null
        ? null
        : new Date(row.activated_at).toISOString(),
  }));
}

async function getMigrationTotals(
  db: ReturnType<typeof getInternalDatabase>,
  asOfDate: string | null,
) {
  const asOfClause =
    asOfDate === null
      ? sql`true`
      : sql`created_at < (${asOfDate}::date + interval '1 day')`;
  const recordAsOfClause =
    asOfDate === null
      ? sql`true`
      : sql`b.created_at < (${asOfDate}::date + interval '1 day')`;
  const result = await db.execute<{
    batches: number;
    records: number;
    quarantined: number;
    imported: number;
  }>(sql`
    select
      (select count(*)::int from migration_batch where ${asOfClause}) as batches,
      (select count(*)::int from migration_record r join migration_batch b on b.id = r.migration_batch_id where ${recordAsOfClause}) as records,
      (select count(*)::int from migration_record r join migration_batch b on b.id = r.migration_batch_id where (r.status = 'QUARANTINED' or r.status = 'INVALID') and ${recordAsOfClause}) as quarantined,
      (select count(*)::int from migration_record r join migration_batch b on b.id = r.migration_batch_id where r.status = 'IMPORTED' and ${recordAsOfClause}) as imported
  `);
  const row = result.rows[0];
  return row ?? { batches: 0, records: 0, quarantined: 0, imported: 0 };
}

function summarize(
  report: ReportName,
  rows: readonly Record<string, unknown>[],
  migrationTotals: Awaited<ReturnType<typeof getMigrationTotals>>,
): Record<string, string | number> {
  return {
    report,
    rowCount: rows.length,
    migrationBatches: migrationTotals.batches,
    migrationRecords: migrationTotals.records,
  };
}

export function serializeCsv(rows: readonly Record<string, unknown>[]): string {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].sort();
  if (columns.length === 0) return "";
  const line = (row: Record<string, unknown>) =>
    columns.map((column) => csvCell(row[column])).join(",");
  return [columns.join(","), ...rows.map(line)].join("\r\n") + "\r\n";
}

function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

function safeAuditData(value: unknown): Record<string, unknown> {
  const redacted = redactAuditValue(value);
  return redacted !== null &&
    typeof redacted === "object" &&
    !Array.isArray(redacted)
    ? (redacted as Record<string, unknown>)
    : {};
}

function redactAuditValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return typeof value === "string" ? value.slice(0, 256) : value;
  }
  if (Array.isArray(value)) return value.map(redactAuditValue);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      /secret|token|password|document|url|ciphertext|ghana|free.?text|comment|note|(?:^|_)(id|.*id)$/i.test(
        key,
      )
    )
      continue;
    result[key] = redactAuditValue(item);
  }
  return result;
}

function maskedReference(value: string): string {
  return `ref-${sha256(value).slice(0, 12)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function asOfDateFilter(filters: Record<string, unknown>): string | null {
  const value = filters.asOfDate;
  if (value === undefined) return null;
  if (typeof value !== "string" || !isIsoCalendarDate(value))
    throw new AppError(
      400,
      "REPORT_AS_OF_DATE_INVALID",
      "The as-of date is invalid.",
    );
  return value;
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year!, month! - 1, day!));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day
  );
}
