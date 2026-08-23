import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { getInternalExecutor } from "../transaction.js";
import { withTransaction } from "../transaction.js";

export interface CompleteReportExportInput {
  exportId: string;
  eventKey: string;
  contentHash: string;
  artifact: Record<string, unknown>;
}

export async function appendReportExportReadyEvent(
  db: Database,
  input: CompleteReportExportInput,
): Promise<boolean> {
  return withTransaction(db, async (tx) => {
    const executor = getInternalExecutor(tx);
    const existing = await executor.execute<{
      content_hash: string | null;
    }>(sql`
      select content_hash
        from report_export_event
       where report_export_id = ${input.exportId}
         and event_type = 'READY'
       order by created_at desc, id desc
       limit 1
       for update
    `);
    if (existing.rows[0] !== undefined) {
      if (existing.rows[0].content_hash !== input.contentHash)
        throw new Error("REPORT_EXPORT_CONTENT_CONFLICT");
      return false;
    }
    const inserted = await executor.execute(sql`
      insert into report_export_event
        (report_export_id, event_key, event_type, content_hash, artifact, created_at)
      values
        (${input.exportId}, ${input.eventKey}, 'READY', ${input.contentHash},
         ${JSON.stringify(input.artifact)}::jsonb, now())
      on conflict (event_key) do nothing
      returning id
    `);
    if (inserted.rows.length === 0) return false;
    return true;
  });
}
