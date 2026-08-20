import {
  isSupportedTenure,
  type PricingMethod,
  type RepaymentFrequency,
  type SupportedTenure,
} from "./types.js";
import { sha256Hex } from "./sha256.js";

export interface WorkedExampleFixture {
  schemaVersion: 1;
  fixtureId: string;
  method: PricingMethod["method"];
  frequency: RepaymentFrequency;
  tenureMonths: SupportedTenure;
  workedExample: Record<string, unknown>;
  canonicalHash: string;
  financeApproved: boolean;
  complianceApproved: boolean;
  licencePermitted: boolean;
  synthetic?: boolean;
}

export interface FixtureKey {
  method: PricingMethod["method"];
  frequency: RepaymentFrequency;
  tenureMonths: SupportedTenure;
}

export function canonicalizeWorkedExample(
  fixture: Omit<WorkedExampleFixture, "canonicalHash">,
): string {
  return JSON.stringify(sortKeys(fixture));
}

export function hashWorkedExample(
  fixture: Omit<WorkedExampleFixture, "canonicalHash">,
): string {
  return sha256Hex(canonicalizeWorkedExample(fixture));
}

export class FinanceApprovalGate {
  readonly #fixtures = new Map<string, WorkedExampleFixture>();

  constructor(
    fixtures: readonly WorkedExampleFixture[] = [],
    private readonly production = true,
  ) {
    for (const fixture of fixtures) this.register(fixture);
  }

  register(fixture: WorkedExampleFixture): void {
    validateFixture(fixture);
    const { canonicalHash, ...unsigned } = fixture;
    if (hashWorkedExample(unsigned) !== canonicalHash) {
      throw new Error("FIXTURE_HASH_INVALID");
    }
    if (this.production && fixture.synthetic === true) {
      throw new Error("SYNTHETIC_FIXTURE_FORBIDDEN");
    }
    this.#fixtures.set(fixtureKey(fixture), Object.freeze({ ...fixture }));
  }

  get size(): number {
    return this.#fixtures.size;
  }

  find(key: FixtureKey): WorkedExampleFixture | null {
    return this.#fixtures.get(fixtureKey(key)) ?? null;
  }

  assertEnabled(key: FixtureKey): WorkedExampleFixture {
    const fixture = this.find(key);
    if (fixture === null) throw new Error("FINANCE_FIXTURE_REQUIRED");
    if (!fixture.financeApproved || !fixture.complianceApproved) {
      throw new Error("FINANCE_COMPLIANCE_APPROVAL_REQUIRED");
    }
    if (!fixture.licencePermitted) throw new Error("LICENCE_PERMISSION_REQUIRED");
    return fixture;
  }
}

export function validateFixture(fixture: WorkedExampleFixture): void {
  if (fixture.schemaVersion !== 1 || fixture.fixtureId.trim().length === 0) {
    throw new Error("FIXTURE_SCHEMA_INVALID");
  }
  if (
    (fixture.method !== "FLAT_MARKUP" && fixture.method !== "REDUCING_BALANCE") ||
    (fixture.frequency !== "WEEKLY" && fixture.frequency !== "MONTHLY") ||
    !isSupportedTenure(fixture.tenureMonths) ||
    typeof fixture.workedExample !== "object" ||
    fixture.workedExample === null ||
    !/^[0-9a-f]{64}$/.test(fixture.canonicalHash)
  ) {
    throw new Error("FIXTURE_SCHEMA_INVALID");
  }
  if (
    typeof fixture.financeApproved !== "boolean" ||
    typeof fixture.complianceApproved !== "boolean" ||
    typeof fixture.licencePermitted !== "boolean"
  ) {
    throw new Error("FIXTURE_SCHEMA_INVALID");
  }
}

function fixtureKey(value: FixtureKey): string {
  return `${value.method}:${value.frequency}:${value.tenureMonths}`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortKeys(child)]),
  );
}
