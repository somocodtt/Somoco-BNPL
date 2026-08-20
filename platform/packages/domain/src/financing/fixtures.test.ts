import { describe, expect, it } from "vitest";
import {
  FinanceApprovalGate,
  canonicalizeJson,
  hashWorkedExample,
  type WorkedExampleFixture,
} from "./fixtures.js";

describe("finance fixture provenance and canonicalization", () => {
  it("uses portable ordinal canonical JSON and deep-freezes registered fixtures", () => {
    const unsigned = {
      schemaVersion: 1 as const,
      fixtureId: "fixture-ordinal",
      method: "FLAT_MARKUP" as const,
      frequency: "MONTHLY" as const,
      tenureMonths: 6 as const,
      workedExample: { "\u{10000}": 1, "\uE000": 2 },
      financeApproved: true,
      complianceApproved: true,
      licencePermitted: true,
      synthetic: false,
    };
    const fixture: WorkedExampleFixture = {
      ...unsigned,
      canonicalHash: hashWorkedExample(unsigned),
    };
    const gate = FinanceApprovalGate.forTesting([fixture]);
    const registered = gate.find({ method: "FLAT_MARKUP", frequency: "MONTHLY", tenureMonths: 6 });

    expect(canonicalizeJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalizeJson({ "2": "two", "10": "ten" })).toBe('{"10":"ten","2":"two"}');
    expect(registered).not.toBeNull();
    expect(Object.isFrozen(registered)).toBe(true);
    expect(Object.isFrozen(registered!.workedExample)).toBe(true);
    expect(() => {
      (registered!.workedExample as Record<string, unknown>).a = 1;
    }).toThrow();
  });

  it("keeps the production constructor fail-closed and rejects synthetic fixtures", () => {
    const unsigned = {
      schemaVersion: 1 as const,
      fixtureId: "synthetic-fixture",
      method: "FLAT_MARKUP" as const,
      frequency: "MONTHLY" as const,
      tenureMonths: 6 as const,
      workedExample: { testOnly: true },
      financeApproved: true,
      complianceApproved: true,
      licencePermitted: true,
      synthetic: true,
    };
    const fixture: WorkedExampleFixture = {
      ...unsigned,
      canonicalHash: hashWorkedExample(unsigned),
    };

    expect(FinanceApprovalGate.production().size).toBe(0);
    expect(() => FinanceApprovalGate.production([fixture])).toThrow(
      "SYNTHETIC_FIXTURE_FORBIDDEN",
    );
    expect(() => FinanceApprovalGate.production([{ ...fixture, synthetic: false }])).toThrow(
      "PRODUCTION_FIXTURE_ATTESTATION_REQUIRED",
    );
  });
});
