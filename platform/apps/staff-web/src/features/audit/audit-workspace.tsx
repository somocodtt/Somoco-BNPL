import type { StaffReportsApi } from "../../lib/api.js";
import { ReportsWorkspace } from "../reports/reports-workspace.js";

export function AuditWorkspace({
  api,
  roles,
}: {
  api: StaffReportsApi;
  roles: readonly string[];
}) {
  return <ReportsWorkspace api={api} roles={roles} reportName="audit" />;
}
