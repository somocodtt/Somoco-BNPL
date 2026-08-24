import type { QueueApplication, StaffRole } from "../../lib/api.js";

export function queueTitle(roles: readonly StaffRole[]): string {
  if (roles.includes("VERIFICATION_OFFICER")) return "Verification queue";
  if (roles.includes("BSM")) return "BSM approval queue";
  if (roles.includes("AGM")) return "AGM approval queue";
  if (roles.includes("CFO")) return "CFO approval queue";
  if (roles.includes("MD")) return "MD approval queue";
  return "Staff queue";
}

export function QueueList({
  items,
  onOpen,
}: {
  items: QueueApplication[];
  onOpen: (applicationId: string) => void;
}) {
  if (items.length === 0) {
    return <p role="status">No actionable applications.</p>;
  }
  return (
    <ul aria-label="Actionable applications" className="queue-list">
      {items.map((item) => (
        <li key={item.id}>
          <article>
            <h2>{String(item.snapshot.applicantName ?? "Applicant")}</h2>
            <p>
              <span>Status: {item.status}</span> ·{" "}
              <span>Version: {item.version}</span>
            </p>
            <button type="button" onClick={() => onOpen(item.id)}>
              Open application
            </button>
          </article>
        </li>
      ))}
    </ul>
  );
}
