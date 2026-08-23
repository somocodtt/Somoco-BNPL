import type { StaffMigrationApi, StaffReportsApi } from "../../lib/api.js";
import { ReportsWorkspace } from "../reports/reports-workspace.js";

export function MigrationWorkspace({
  api,
  migrationApi,
  roles,
}: {
  api: StaffReportsApi;
  migrationApi: StaffMigrationApi;
  roles: readonly string[];
}) {
  return (
    <ReportsWorkspace
      api={api}
      migrationApi={migrationApi}
      roles={roles}
      reportName="migration"
    />
  );
}
