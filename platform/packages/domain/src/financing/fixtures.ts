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
  synthetic: boolean;
}

export interface FixtureKey {
  method: PricingMethod["method"];
  frequency: RepaymentFrequency;
  tenureMonths: SupportedTenure;
}

export function canonicalizeWorkedExample(
  fixture: Omit<WorkedExampleFixture, "canonicalHash">,
): string {
  return canonicalizeJson(fixture);
}

export function hashWorkedExample(
  fixture: Omit<WorkedExampleFixture, "canonicalHash">,
): string {
  return sha256Hex(canonicalizeWorkedExample(fixture));
}

export function canonicalizeJson(value: unknown): string {
  return encodeCanonical(value);
}

export class FinanceApprovalGate {
  readonly #fixtures = new Map<string, WorkedExampleFixture>();
  readonly #production: boolean;

  private constructor(
    fixtures: readonly WorkedExampleFixture[],
    production: boolean,
  ) {
    this.#production = production;
    for (const fixture of fixtures) this.#register(fixture);
  }

  static production(
    fixtures: readonly WorkedExampleFixture[] = [],
  ): FinanceApprovalGate {
    for (const fixture of fixtures) {
      validateFixture(fixture);
      if (fixture.synthetic) throw new Error("SYNTHETIC_FIXTURE_FORBIDDEN");
    }
    if (fixtures.length > 0) {
      throw new Error("PRODUCTION_FIXTURE_ATTESTATION_REQUIRED");
    }
    return new FinanceApprovalGate([], true);
  }

  static forTesting(
    fixtures: readonly WorkedExampleFixture[] = [],
  ): FinanceApprovalGate {
    return new FinanceApprovalGate(fixtures, false);
  }

  get size(): number {
    return this.#fixtures.size;
  }

  get isProduction(): boolean {
    return this.#production;
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

  #register(fixture: WorkedExampleFixture): void {
    validateFixture(fixture);
    const { canonicalHash, ...unsigned } = fixture;
    if (hashWorkedExample(unsigned) !== canonicalHash) {
      throw new Error("FIXTURE_HASH_INVALID");
    }
    if (this.#production && fixture.synthetic) {
      throw new Error("SYNTHETIC_FIXTURE_FORBIDDEN");
    }
    this.#fixtures.set(fixtureKey(fixture), deepFreeze(deepClone(fixture)));
  }
}

export function validateFixture(fixture: WorkedExampleFixture): void {
  if (
    typeof fixture !== "object" ||
    fixture === null ||
    fixture.schemaVersion !== 1 ||
    typeof fixture.fixtureId !== "string" ||
    fixture.fixtureId.trim().length === 0
  ) {
    throw new Error("FIXTURE_SCHEMA_INVALID");
  }
  if (
    (fixture.method !== "FLAT_MARKUP" && fixture.method !== "REDUCING_BALANCE") ||
    (fixture.frequency !== "WEEKLY" && fixture.frequency !== "MONTHLY") ||
    !isSupportedTenure(fixture.tenureMonths) ||
    typeof fixture.workedExample !== "object" ||
    fixture.workedExample === null ||
    Array.isArray(fixture.workedExample) ||
    !/^[0-9a-f]{64}$/.test(fixture.canonicalHash)
  ) {
    throw new Error("FIXTURE_SCHEMA_INVALID");
  }
  if (
    typeof fixture.financeApproved !== "boolean" ||
    typeof fixture.complianceApproved !== "boolean" ||
    typeof fixture.licencePermitted !== "boolean" ||
    typeof fixture.synthetic !== "boolean"
  ) {
    throw new Error("FIXTURE_SCHEMA_INVALID");
  }
}

function fixtureKey(value: FixtureKey): string {
  return `${value.method}:${value.frequency}:${value.tenureMonths}`;
}

function canonicalValue(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_JSON_VALUE_INVALID");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new Error("CANONICAL_JSON_VALUE_INVALID");
    }
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareOrdinal)
        .map((key) => [key, canonicalValue((value as Record<string, unknown>)[key])]),
    );
  }
  throw new Error("CANONICAL_JSON_VALUE_INVALID");
}

function encodeCanonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("CANONICAL_JSON_VALUE_INVALID");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(encodeCanonical).join(",")}]`;
  if (typeof value === "object") {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error("CANONICAL_JSON_VALUE_INVALID");
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort(compareOrdinal)
      .map((key) => `${JSON.stringify(key)}:${encodeCanonical(record[key])}`)
      .join(",")}}`;
  }
  throw new Error("CANONICAL_JSON_VALUE_INVALID");
}

function compareOrdinal(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    if (leftPoints[index]! !== rightPoints[index]!) {
      return leftPoints[index]! - rightPoints[index]!;
    }
  }
  return leftPoints.length - rightPoints.length;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => deepClone(item)) as T;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, deepClone(child)]),
  ) as T;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
