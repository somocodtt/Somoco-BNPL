import type { StaffRole } from "../../lib/api.js";

export function canReview(roles: readonly StaffRole[]): boolean {
  return roles.some((role) =>
    ["VERIFICATION_OFFICER", "BSM", "AGM", "CFO", "MD"].includes(role),
  );
}
