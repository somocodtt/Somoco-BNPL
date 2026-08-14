import { describe, expect, it } from "vitest";
import { assertTransition } from "./application-state.js";
import { ghs } from "./money.js";

describe("application transitions", () => {
  it("permits the approved application sequence", () => {
    const sequence = [
      ["DRAFT", "AWAITING_GUARANTOR"],
      ["AWAITING_GUARANTOR", "READY_TO_SUBMIT"],
      ["READY_TO_SUBMIT", "VERIFICATION_REVIEW"],
      ["VERIFICATION_REVIEW", "BSM_INITIAL_REVIEW"],
      ["BSM_INITIAL_REVIEW", "AGM_REVIEW"],
      ["AGM_REVIEW", "CFO_REVIEW"],
      ["CFO_REVIEW", "BSM_FINAL_REVIEW"],
      ["BSM_FINAL_REVIEW", "MD_REVIEW"],
      ["MD_REVIEW", "APPROVED"],
      ["APPROVED", "AWAITING_DEPOSIT"],
      ["AWAITING_DEPOSIT", "AWAITING_ASSET_ASSIGNMENT"],
      ["AWAITING_ASSET_ASSIGNMENT", "AWAITING_EXECUTION"],
      ["AWAITING_EXECUTION", "ACTIVE"],
    ] as const;

    for (const [from, to] of sequence) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }

    expect(() =>
      assertTransition("ACTIVE", "SETTLED", { outstandingBalance: ghs(0n) }),
    ).not.toThrow();
  });

  it("rejects skipping from verification to CFO", () => {
    expect(() =>
      assertTransition("VERIFICATION_REVIEW", "CFO_REVIEW"),
    ).toThrowError("APPLICATION_TRANSITION_NOT_ALLOWED");
  });

  it("rejects asset assignment before the deposit", () => {
    expect(() =>
      assertTransition("APPROVED", "AWAITING_ASSET_ASSIGNMENT"),
    ).toThrowError("APPLICATION_TRANSITION_NOT_ALLOWED");
  });

  it("rejects activation before physical execution", () => {
    expect(() =>
      assertTransition("AWAITING_ASSET_ASSIGNMENT", "ACTIVE"),
    ).toThrowError("APPLICATION_TRANSITION_NOT_ALLOWED");
  });

  it("rejects settlement with an outstanding balance", () => {
    expect(() =>
      assertTransition("ACTIVE", "SETTLED", { outstandingBalance: ghs(1n) }),
    ).toThrowError("APPLICATION_TRANSITION_NOT_ALLOWED");
  });

  it("requires an explicit zero balance before settlement", () => {
    expect(() => assertTransition("ACTIVE", "SETTLED")).toThrowError(
      "APPLICATION_TRANSITION_NOT_ALLOWED",
    );
  });
});
