import type { Money } from "./money.js";

export type ApplicationStatus =
  | "DRAFT"
  | "AWAITING_GUARANTOR"
  | "READY_TO_SUBMIT"
  | "VERIFICATION_REVIEW"
  | "BSM_INITIAL_REVIEW"
  | "AGM_REVIEW"
  | "CFO_REVIEW"
  | "BSM_FINAL_REVIEW"
  | "MD_REVIEW"
  | "INFORMATION_REQUESTED"
  | "REJECTED"
  | "APPROVED"
  | "AWAITING_DEPOSIT"
  | "AWAITING_ASSET_ASSIGNMENT"
  | "AWAITING_EXECUTION"
  | "ACTIVE"
  | "SETTLED"
  | "RECOVERY";

export type ApprovalStage =
  "VERIFICATION" | "BSM_INITIAL" | "AGM" | "CFO" | "BSM_FINAL" | "MD";

export type TransitionContext = Readonly<{
  outstandingBalance?: Money;
}>;

export const APPLICATION_TRANSITIONS: Readonly<
  Record<ApplicationStatus, readonly ApplicationStatus[]>
> = {
  DRAFT: ["AWAITING_GUARANTOR"],
  AWAITING_GUARANTOR: ["READY_TO_SUBMIT"],
  READY_TO_SUBMIT: ["VERIFICATION_REVIEW"],
  VERIFICATION_REVIEW: [
    "BSM_INITIAL_REVIEW",
    "INFORMATION_REQUESTED",
    "REJECTED",
  ],
  BSM_INITIAL_REVIEW: ["AGM_REVIEW", "INFORMATION_REQUESTED", "REJECTED"],
  AGM_REVIEW: ["CFO_REVIEW", "INFORMATION_REQUESTED", "REJECTED"],
  CFO_REVIEW: ["BSM_FINAL_REVIEW", "INFORMATION_REQUESTED", "REJECTED"],
  BSM_FINAL_REVIEW: ["MD_REVIEW", "INFORMATION_REQUESTED", "REJECTED"],
  MD_REVIEW: ["APPROVED", "INFORMATION_REQUESTED", "REJECTED"],
  INFORMATION_REQUESTED: ["VERIFICATION_REVIEW"],
  REJECTED: [],
  APPROVED: ["AWAITING_DEPOSIT"],
  AWAITING_DEPOSIT: ["AWAITING_ASSET_ASSIGNMENT"],
  AWAITING_ASSET_ASSIGNMENT: ["AWAITING_EXECUTION"],
  AWAITING_EXECUTION: ["ACTIVE"],
  ACTIVE: ["SETTLED", "RECOVERY"],
  SETTLED: [],
  RECOVERY: [],
};

export function assertTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
  context?: TransitionContext,
): void {
  if (!APPLICATION_TRANSITIONS[from].includes(to)) {
    throw new Error("APPLICATION_TRANSITION_NOT_ALLOWED");
  }

  if (
    from === "ACTIVE" &&
    to === "SETTLED" &&
    (context?.outstandingBalance?.currency !== "GHS" ||
      context.outstandingBalance.minorUnits !== 0n)
  ) {
    throw new Error("APPLICATION_TRANSITION_NOT_ALLOWED");
  }
}
