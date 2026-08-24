import type { StaffAction } from "./actions.js";

export type StaffRole =
  | "VERIFICATION_OFFICER"
  | "BSM"
  | "AGM"
  | "CFO"
  | "MD"
  | "PRODUCT_ADMIN"
  | "INVENTORY_OFFICER"
  | "FINANCE_OFFICER"
  | "RECOVERY_OFFICER"
  | "COMPLIANCE_AUDITOR"
  | "CUSTOMER_SUPPORT"
  | "SYSTEM_ADMIN";

export interface StaffPrincipal {
  kind: "staff";
  staffUserId: string;
  roles: readonly StaffRole[];
  sessionId: string;
}

export interface CustomerPrincipal {
  kind: "customer";
  customerAccountId: string;
  personId: string;
  sessionId: string;
}

const actionRoles = {
  "application.verify": ["VERIFICATION_OFFICER"],
  "application.approve.bsm.initial": ["BSM"],
  "application.approve.bsm.final": ["BSM"],
  "application.approve.agm": ["AGM"],
  "application.approve.cfo": ["CFO"],
  "application.approve.md": ["MD"],
  "product.manage": ["PRODUCT_ADMIN"],
  "inventory.manage": ["INVENTORY_OFFICER"],
  "tracker.view": ["RECOVERY_OFFICER"],
  "payment.post": ["FINANCE_OFFICER"],
  "collections.compute": ["RECOVERY_OFFICER"],
  "recovery.authorize": ["RECOVERY_OFFICER"],
  "compliance.audit": ["COMPLIANCE_AUDITOR"],
  "customer_support.manage": ["CUSTOMER_SUPPORT"],
  "ownership.transfer": ["INVENTORY_OFFICER"],
  "staff_user.create": ["SYSTEM_ADMIN"],
  "staff_user.update": ["SYSTEM_ADMIN"],
} as const satisfies Record<StaffAction, readonly StaffRole[]>;

export function authorize(
  principal: StaffPrincipal,
  action: StaffAction,
): void {
  if (
    principal.roles.includes("SYSTEM_ADMIN") &&
    action !== "staff_user.create" &&
    action !== "staff_user.update"
  ) {
    throw new Error("FORBIDDEN");
  }
  const allowedRoles = (
    actionRoles as Partial<Record<string, readonly StaffRole[]>>
  )[action];
  if (
    allowedRoles === undefined ||
    !principal.roles.some((role) => allowedRoles.includes(role))
  ) {
    throw new Error("FORBIDDEN");
  }
}
