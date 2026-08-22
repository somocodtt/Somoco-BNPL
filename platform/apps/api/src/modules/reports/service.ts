import { createHash, randomUUID } from "node:crypto";
import { sql } from "../../../../../packages/db/node_modules/drizzle-orm/index.js";
import { enqueueOutbox, withTransaction, type Database } from "@somo/db";
import { getInternalDatabase } from "../../../../../packages/db/src/client.js";
import { reportExport } from "../../../../../packages/db/src/schema/reports.js";
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

export function createReportService(options: {
  database: Database;
}): ReportService {
  async function read(
    actor: StaffPrincipal,
    report: ReportName,
    filters: ReportFilters = {},
  ): Promise<ReportResult> {
    requireReportRead(actor);
    const dataClassification = classify(actor, filters);
    const internal = getInternalDatabase(options.database);
    const safeFilters = sanitizeFilters(filters);
    const rows =
      report === "operations"
        ? await listOperations(internal, safeFilters, dataClassification)
        : report === "portfolio"
          ? await listPortfolio(internal, safeFilters, dataClassification)
          : report === "audit"
            ? await listAudit(internal)
            : await listMigration(internal);
    const migrationTotals = await getMigrationTotals(internal);
    return {
      report,
      generatedAt: new Date().toISOString(),
      dataClassification,
      filters: safeFilters,
      rows,
      rowCount: rows.length,
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
      requireReportRead(input.actor);
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
      requireReportRead(input.actor);
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
      return {
        id: row.id,
        report: row.report_type.toLowerCase() as ReportName,
        format: row.format,
        dataClassification: row.data_classification,
        requesterStaffUserId: row.requester_staff_user_id,
        requestId: row.request_id,
        rowCount: row.row_count,
        contentHash: row.content_hash,
        watermark: String(row.artifact.watermark ?? ""),
        content:
          typeof row.artifact.content === "string" ? row.artifact.content : "",
        status: row.status,
      };
    },
  };
}

function requireReportRead(actor: StaffPrincipal): void {
  if (
    actor.kind !== "staff" ||
    !actor.roles.some((role) => OPERATIONAL_ROLES.has(role))
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
               and i.status in ('FAILED', 'MANUAL_REVIEW')) as nia_exceptions,
           exists(select 1 from offer o
                    where o.application_id = a.id
                      and o.status in ('PENDING', 'ACCEPTED')
                      and not exists (
                        select 1 from deposit_reconciliation dr
                         where dr.application_id = a.id
                           and dr.offer_id = o.id
                           and dr.status = 'RECONCILED'
                      )) as offer_awaiting_deposit,
           case when exists(select 1 from payment_transaction p
                              join contract pc on pc.id = p.contract_id
                             where pc.application_id = a.id and p.status = 'RECEIVED')
                then 'RECEIVED' else 'NONE' end as payment_state,
           coalesce((select c.status::text from contract c where c.application_id = a.id limit 1), 'NONE') as contract_state,
           (select c.outstanding_balance_minor_units from contract c where c.application_id = a.id limit 1) as balance,
           (select vu.status::text from vehicle_unit vu join contract c on c.vehicle_unit_id = vu.id where c.application_id = a.id limit 1) as vehicle_state,
           coalesce((select max(x.consecutive_missed_installments)::int from arrears_snapshot x join contract c on c.id = x.contract_id where c.application_id = a.id), 0) as consecutive_missed,
           coalesce((select max(x.unpaid_installments)::int from arrears_snapshot x join contract c on c.id = x.contract_id where c.application_id = a.id), 0) as total_unpaid,
           (select count(*)::int from recovery_case r join contract c on c.id = r.contract_id where c.application_id = a.id and r.status <> 'CLOSED') as recovery_cases,
           (select count(*)::int from reconciliation_case rc join payment_transaction p on p.id = rc.payment_transaction_id join contract c on c.id = p.contract_id where c.application_id = a.id and rc.status <> 'RESOLVED') as integration_exceptions
      from application a
     where ${statusClause}
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
  const result = await db.execute<{
    id: string;
    reference: string;
    status: string;
    balance: bigint | string;
    ownership_holder: string;
    vehicle_status: string;
    consecutive_missed: number;
    total_unpaid: number;
  }>(sql`
    select c.id, c.reference, c.status, c.outstanding_balance_minor_units as balance,
           c.ownership_holder, vu.status::text as vehicle_status,
           coalesce((select max(a.consecutive_missed_installments)::int from arrears_snapshot a where a.contract_id = c.id), 0) as consecutive_missed,
           coalesce((select max(a.unpaid_installments)::int from arrears_snapshot a where a.contract_id = c.id), 0) as total_unpaid
      from contract c join vehicle_unit vu on vu.id = c.vehicle_unit_id
     where ${statusClause}
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
    accountReference:
      classification === "PERSONAL_DATA"
        ? row.reference
        : maskedReference(row.reference),
  }));
}

async function listAudit(
  db: ReturnType<typeof getInternalDatabase>,
): Promise<readonly Record<string, unknown>[]> {
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
     order by occurred_at desc, id desc limit 1000
  `);
  return result.rows.map((row) => ({
    id: row.id,
    aggregateType: row.aggregate_type,
    action: row.action,
    actorStaffUserId: row.actor_staff_user_id,
    requestId: row.request_id,
    occurredAt: new Date(row.occurred_at).toISOString(),
    data: safeAuditData(row.data),
  }));
}

async function listMigration(
  db: ReturnType<typeof getInternalDatabase>,
): Promise<readonly Record<string, unknown>[]> {
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

async function getMigrationTotals(db: ReturnType<typeof getInternalDatabase>) {
  const result = await db.execute<{
    batches: number;
    records: number;
    quarantined: number;
    imported: number;
  }>(sql`
    select
      (select count(*)::int from migration_batch) as batches,
      (select count(*)::int from migration_record) as records,
      (select count(*)::int from migration_record where status = 'QUARANTINED' or status = 'INVALID') as quarantined,
      (select count(*)::int from migration_record where status = 'IMPORTED') as imported
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
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return {};
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (/secret|token|password|document|url|ciphertext|ghana/i.test(key))
      continue;
    result[key] = typeof item === "string" ? item.slice(0, 256) : item;
  }
  return result;
}

function maskedReference(value: string): string {
  return `ref-${sha256(value).slice(0, 12)}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
