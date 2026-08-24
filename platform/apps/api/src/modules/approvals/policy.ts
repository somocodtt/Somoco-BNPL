import {
  authorize,
  type StaffPrincipal,
  type StaffRole,
} from "../access/policy.js";

export type ApprovalStage =
  "VERIFICATION" | "BSM_INITIAL" | "AGM" | "CFO" | "BSM_FINAL" | "MD";

export type ApprovalAction = "APPROVE" | "REJECT" | "REQUEST_INFORMATION";

export type DecisionActor = StaffPrincipal;

export interface TemporaryDelegation {
  delegateId: string;
  role: StaffRole;
  scope: readonly ApprovalStage[];
  approvedBy: string;
  effectiveFrom: string;
  effectiveUntil: string;
}

export interface DecisionAuthorizationOptions {
  exceptionRequestedBy?: string;
  delegation?: TemporaryDelegation;
  now?: string | Date;
}

const roleForStage: Readonly<Record<ApprovalStage, StaffRole>> = {
  VERIFICATION: "VERIFICATION_OFFICER",
  BSM_INITIAL: "BSM",
  AGM: "AGM",
  CFO: "CFO",
  BSM_FINAL: "BSM",
  MD: "MD",
};

const statusForApprovalStage: Readonly<Record<ApprovalStage, string>> = {
  VERIFICATION: "VERIFICATION_REVIEW",
  BSM_INITIAL: "BSM_INITIAL_REVIEW",
  AGM: "AGM_REVIEW",
  CFO: "CFO_REVIEW",
  BSM_FINAL: "BSM_FINAL_REVIEW",
  MD: "MD_REVIEW",
};

const nextStatusForStage: Readonly<Record<ApprovalStage, string>> = {
  VERIFICATION: "BSM_INITIAL_REVIEW",
  BSM_INITIAL: "AGM_REVIEW",
  AGM: "CFO_REVIEW",
  CFO: "BSM_FINAL_REVIEW",
  BSM_FINAL: "MD_REVIEW",
  MD: "APPROVED",
};

const actionForStage: Readonly<Record<ApprovalStage, string>> = {
  VERIFICATION: "application.verify",
  BSM_INITIAL: "application.approve.bsm.initial",
  AGM: "application.approve.agm",
  CFO: "application.approve.cfo",
  BSM_FINAL: "application.approve.bsm.final",
  MD: "application.approve.md",
};

export function stageRole(stage: ApprovalStage): StaffRole {
  return roleForStage[stage];
}

export function reviewStatusForStage(stage: ApprovalStage): string {
  return statusForApprovalStage[stage];
}

export function nextStatusForApproval(stage: ApprovalStage): string {
  return nextStatusForStage[stage];
}

export function actionForApprovalStage(stage: ApprovalStage): string {
  return actionForStage[stage];
}

export function stageForReviewStatus(status: string): ApprovalStage | null {
  for (const stage of Object.keys(statusForApprovalStage) as ApprovalStage[]) {
    if (statusForApprovalStage[stage] === status) return stage;
  }
  return null;
}

export function assertDecisionAllowed(
  actor: DecisionActor,
  stage: ApprovalStage,
  options: DecisionAuthorizationOptions = {},
): void {
  if (options.exceptionRequestedBy === actor.staffUserId) {
    throw new Error("EXCEPTION_REQUESTER_CANNOT_APPROVE");
  }
  if (actor.roles.includes("SYSTEM_ADMIN")) {
    throw new Error("FORBIDDEN");
  }

  const action = actionForApprovalStage(stage);
  try {
    authorize(actor, action as Parameters<typeof authorize>[1]);
    return;
  } catch {
    // A delegation can only add one bounded, approved, time-limited stage.
  }

  const delegation = options.delegation;
  if (delegation === undefined) throw new Error("FORBIDDEN");
  if (delegation.delegateId !== actor.staffUserId) throw new Error("FORBIDDEN");
  if (delegation.role !== roleForStage[stage]) throw new Error("FORBIDDEN");
  if (!delegation.scope.includes(stage)) throw new Error("FORBIDDEN");
  if (delegation.approvedBy === actor.staffUserId) {
    throw new Error("DELEGATION_APPROVER_INVALID");
  }
  const from = parseDate(
    delegation.effectiveFrom,
    "DELEGATION_EFFECTIVE_DATE_INVALID",
  );
  const until = parseDate(
    delegation.effectiveUntil,
    "DELEGATION_EFFECTIVE_DATE_INVALID",
  );
  if (until <= from) throw new Error("DELEGATION_WINDOW_INVALID");
  const now = parseDate(options.now ?? new Date(), "DELEGATION_NOW_INVALID");
  if (now < from || now >= until) throw new Error("DELEGATION_EXPIRED");
}

function parseDate(value: string | Date, code: string): Date {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(code);
  return date;
}
