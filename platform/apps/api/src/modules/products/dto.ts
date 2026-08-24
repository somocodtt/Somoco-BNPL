import type {
  ExceptionRecord,
  FinancingRuleRecord,
  OfferRecord,
} from "@somo/db";

/**
 * HTTP is a trust boundary: database bigint values and Date instances never
 * cross it.  Keep this mapper deliberately explicit so adding a persisted
 * amount cannot accidentally make a route's JSON response unserialisable.
 */
export function serializeRuleDto(
  rule: FinancingRuleRecord,
): Record<string, unknown> {
  assertApprovedFeePolicy(rule.permittedFees);
  if (rule.gateStatus !== "OPEN" && rule.gateStatus !== "CLOSED") {
    throw new Error("RULE_GATE_STATUS_REQUIRED");
  }
  return {
    id: rule.id,
    productId: rule.productId,
    productCode: rule.productCode,
    productName: rule.productName,
    vehicleModelId: rule.vehicleModelId,
    versionNumber: rule.versionNumber,
    sellingPriceMinor: rule.sellingPriceMinor.toString(),
    minimumDepositMinor: rule.minimumDepositMinor.toString(),
    annualRateBps: rule.annualRateBps,
    allowedTenuresMonths: [...rule.allowedTenuresMonths],
    repaymentFrequencies: [...rule.repaymentFrequencies],
    method: rule.calculationMethod,
    permittedFees: rule.permittedFees,
    eligibilityPolicy: rule.eligibilityPolicy,
    requiredEvidence: [...rule.requiredEvidence],
    exceptionPolicy: rule.exceptionPolicy,
    disclosureVersion: rule.disclosureVersion,
    disclosureContent: rule.disclosureContent ?? null,
    disclosureHash: rule.disclosureHash ?? null,
    fixtureHashes: [...rule.fixtureHashes],
    licencePermitted: rule.licencePermitted,
    approved: rule.approved,
    requestedBy: rule.requestedBy,
    approvedBy: rule.approvedBy,
    approvedAt: rule.approvedAt?.toISOString() ?? null,
    effectiveFrom: rule.effectiveFrom?.toISOString() ?? null,
    effectiveUntil: rule.effectiveUntil?.toISOString() ?? null,
    publishedAt: rule.publishedAt?.toISOString() ?? null,
    status: rule.approved && rule.publishedAt !== null ? "PUBLISHED" : "DRAFT",
    gate: rule.gateStatus,
  };
}

export function serializeExceptionDto(
  exception: ExceptionRecord,
): Record<string, unknown> {
  return {
    id: exception.id,
    applicationId: exception.applicationId,
    ruleVersionId: exception.ruleVersionId ?? null,
    field: exception.exceptionField ?? null,
    valueType: exception.valueType ?? null,
    proposedValue: exception.proposedValue,
    policyValue: exception.policyValue,
    proposedAmountMinor: exception.proposedAmountMinor?.toString() ?? null,
    policyAmountMinor: exception.policyAmountMinor?.toString() ?? null,
    proposedFrequency: exception.proposedFrequency ?? null,
    policyFrequency: exception.policyFrequency ?? null,
    proposedTenureMonths: exception.proposedTenureMonths ?? null,
    policyTenureMonths: exception.policyTenureMonths ?? null,
    reason: exception.reason,
    requiredApproverRole: exception.requiredApproverRole,
    requestedBy: exception.requestedBy,
    status: exception.status,
    version: exception.version,
    decidedBy: exception.decidedBy,
    decidedAt: exception.decidedAt?.toISOString() ?? null,
    expiresAt: exception.expiresAt?.toISOString() ?? null,
  };
}

export function serializeOfferDto(offer: OfferRecord): Record<string, unknown> {
  const terms = offer.offerVersion?.terms ?? {};
  assertApprovedFeePolicy(terms.fees);
  const installments = Array.isArray(terms.installments)
    ? terms.installments.map((item) => serializeInstallment(item))
    : [];
  const money = (name: string, fallback?: bigint): string | null => {
    const value = terms[name];
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "string" && /^\d+$/.test(value)) return value;
    return fallback === undefined ? null : fallback.toString();
  };
  return {
    id: offer.id,
    offerId: offer.id,
    applicationId: offer.applicationId,
    status: offer.status,
    version: offer.version,
    expiresAt: offer.expiresAt?.toISOString() ?? null,
    acceptedAt: offer.acceptedAt?.toISOString() ?? null,
    disclosedVersion: offer.disclosedVersion ?? terms.disclosureVersion ?? null,
    disclosedHash: offer.disclosedHash ?? null,
    consentAt: offer.consentAt?.toISOString() ?? null,
    priceMinor: money("priceMinor"),
    depositMinor: money("depositMinor", offer.offerVersion?.depositMinor),
    principalMinor: money("principalMinor", offer.offerVersion?.principalMinor),
    financeChargeMinor: money("financeChargeMinor"),
    totalPayableMinor: money(
      "totalPayableMinor",
      offer.offerVersion?.totalPayableMinor,
    ),
    frequency: stringValue(terms.frequency),
    tenureMonths: numberValue(terms.tenureMonths),
    method: stringValue(terms.method),
    rateBasisPoints: numberValue(terms.rateBasisPoints),
    fees: terms.fees,
    disclosureVersion:
      stringValue(terms.disclosureVersion) ?? offer.disclosedVersion,
    disclosureContent: isRecord(terms.disclosureContent)
      ? terms.disclosureContent
      : null,
    installments,
  };
}

function serializeInstallment(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return {
    sequence: value.sequence,
    dueDate: value.dueDate,
    principalMinor: minorValue(value.principalMinor),
    chargeMinor: minorValue(value.chargeMinor),
    totalMinor: minorValue(value.totalMinor),
  };
}

function minorValue(value: unknown): string | null {
  if (typeof value === "bigint") return value.toString();
  return typeof value === "string" && /^\d+$/.test(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertApprovedFeePolicy(
  value: unknown,
): asserts value is Record<string, unknown> {
  try {
    if (
      !isRecord(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.keys(value).length > 0
    ) {
      throw new Error("FEES_POLICY_INVALID");
    }
  } catch (error) {
    if (error instanceof Error && error.message === "FEES_POLICY_INVALID")
      throw error;
    throw new Error("FEES_POLICY_INVALID", { cause: error });
  }
}
