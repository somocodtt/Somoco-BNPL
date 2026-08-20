import { sql } from "drizzle-orm";
import type { Database } from "../client.js";
import {
  getInternalExecutor,
  type DatabaseTransaction,
} from "../transaction.js";

export interface FinancingCommandRecord {
  id: string;
  scope: string;
  idempotencyKey: string;
  commandType: string;
  payloadHash: string;
  response: Record<string, unknown>;
}

export interface FinancingRuleRecord {
  id: string;
  productId: string;
  productCode: string;
  productName: string;
  vehicleModelId: string;
  versionNumber: number;
  sellingPriceMinor: bigint;
  minimumDepositMinor: bigint;
  annualRateBps: number;
  allowedTenuresMonths: number[];
  repaymentFrequencies: Array<"WEEKLY" | "MONTHLY">;
  calculationMethod: "FLAT_MARKUP" | "REDUCING_BALANCE";
  permittedFees: Record<string, unknown>;
  eligibilityPolicy: Record<string, unknown>;
  requiredEvidence: string[];
  exceptionPolicy: Record<string, unknown>;
  disclosureVersion: string | null;
  fixtureHashes: string[];
  licencePermitted: boolean;
  approved: boolean;
  requestedBy: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  effectiveFrom: Date | null;
  effectiveUntil: Date | null;
  publishedAt: Date | null;
}

export interface ExceptionRecord {
  id: string;
  applicationId: string;
  proposedValue: unknown;
  policyValue: unknown;
  reason: string;
  requiredApproverRole: string;
  requestedBy: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  version: number;
  decidedBy: string | null;
  decidedAt: Date | null;
  expiresAt: Date | null;
}

export interface OfferRecord {
  id: string;
  applicationId: string;
  status: "PENDING" | "EXPIRED" | "ACCEPTED" | "CANCELLED";
  version: number;
  acceptedVersionId: string | null;
  acceptedAt: Date | null;
  acceptedHash: string | null;
  consentAt: Date | null;
  expiresAt: Date | null;
  acceptedByPersonId: string | null;
  offerVersion: {
    id: string;
    versionNumber: number;
    financingRuleVersionId: string;
    principalMinor: bigint;
    depositMinor: bigint;
    totalPayableMinor: bigint;
    terms: Record<string, unknown>;
    canonicalHash: string | null;
  } | null;
}

export interface ApplicationGateRecord {
  id: string;
  status: string;
  version: number;
  productId: string | null;
  vehicleModelId: string | null;
  applicantPersonId: string;
}

export function financingRepo(db: Database | DatabaseTransaction) {
  const executor = getInternalExecutor(db);
  return {
    async findCommand(
      scope: string,
      idempotencyKey: string,
    ): Promise<FinancingCommandRecord | null> {
      const result = await executor.execute<CommandRow>(sql`
        select id, scope, idempotency_key, command_type, payload_hash, response
          from financing_command
         where scope = ${scope} and idempotency_key = ${idempotencyKey}
         limit 1
      `);
      return result.rows[0] === undefined
        ? null
        : mapCommand(result.rows[0]);
    },

    async insertCommand(input: {
      scope: string;
      idempotencyKey: string;
      commandType: string;
      payloadHash: string;
      actorStaffUserId?: string;
      actorPersonId?: string;
      applicationId?: string;
      response: Record<string, unknown>;
    }): Promise<FinancingCommandRecord> {
      const result = await executor.execute<CommandRow>(sql`
        insert into financing_command
          (scope, idempotency_key, command_type, payload_hash,
           actor_staff_user_id, actor_person_id, application_id, response)
        values (
          ${input.scope}, ${input.idempotencyKey}, ${input.commandType},
          ${input.payloadHash}, ${input.actorStaffUserId ?? null}::uuid,
          ${input.actorPersonId ?? null}::uuid, ${input.applicationId ?? null}::uuid,
          ${input.response}::jsonb
        )
        returning id, scope, idempotency_key, command_type, payload_hash, response
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("FINANCING_COMMAND_INSERT_FAILED");
      return mapCommand(row);
    },

    async insertRule(input: {
      id: string;
      productId: string;
      versionNumber: number;
      sellingPriceMinor: bigint;
      minimumDepositMinor: bigint;
      annualRateBps: number;
      allowedTenuresMonths: readonly number[];
      repaymentFrequencies: readonly string[];
      calculationMethod: string;
      permittedFees: Record<string, unknown>;
      eligibilityPolicy: Record<string, unknown>;
      requiredEvidence: readonly string[];
      exceptionPolicy: Record<string, unknown>;
      disclosureVersion?: string;
      fixtureHashes: readonly string[];
      licencePermitted: boolean;
      requestedBy: string;
      effectiveFrom?: Date;
      effectiveUntil?: Date;
    }): Promise<{ id: string; versionNumber: number }> {
      const result = await executor.execute<{
        id: string;
        version_number: number;
      }>(sql`
        insert into financing_rule_version
          (id, product_id, version_number, selling_price_minor_units,
           minimum_deposit_minor_units, annual_rate_bps, allowed_tenures_months,
           repayment_frequencies, calculation_method, permitted_fees,
           eligibility_policy, required_evidence, exception_policy,
           disclosure_version, fixture_hashes, licence_permitted, requested_by,
           effective_from, effective_until)
        values (
          ${input.id}::uuid, ${input.productId}::uuid, ${input.versionNumber},
          ${input.sellingPriceMinor}::bigint, ${input.minimumDepositMinor}::bigint,
          ${input.annualRateBps}, ${JSON.stringify(input.allowedTenuresMonths)}::jsonb,
          ${JSON.stringify(input.repaymentFrequencies)}::jsonb, ${input.calculationMethod},
          ${input.permittedFees}::jsonb, ${input.eligibilityPolicy}::jsonb,
          ${JSON.stringify(input.requiredEvidence)}::jsonb, ${input.exceptionPolicy}::jsonb,
          ${input.disclosureVersion ?? null}, ${JSON.stringify(input.fixtureHashes)}::jsonb,
          ${input.licencePermitted}, ${input.requestedBy}::uuid,
          ${input.effectiveFrom ?? null}, ${input.effectiveUntil ?? null}
        )
        returning id, version_number
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("FINANCING_RULE_INSERT_FAILED");
      return { id: row.id, versionNumber: row.version_number };
    },

    async publishRule(input: {
      ruleId: string;
      actorStaffUserId: string;
      effectiveFrom: Date;
      effectiveUntil?: Date;
    }): Promise<FinancingRuleRecord> {
      const result = await executor.execute<RuleRow>(sql`
        update financing_rule_version as rule
           set approved = true,
               approved_by = ${input.actorStaffUserId}::uuid,
               approved_at = clock_timestamp(),
               effective_from = ${input.effectiveFrom},
               effective_until = ${input.effectiveUntil ?? null},
               published_at = clock_timestamp()
          from product
         where rule.id = ${input.ruleId}::uuid
           and product.id = rule.product_id
           and rule.approved = false
           and (rule.requested_by is null or rule.requested_by <> ${input.actorStaffUserId}::uuid)
           and not exists (
             select 1 from financing_rule_version prior
              where prior.product_id = rule.product_id
                and prior.approved = true
                and prior.effective_from is not null
                and coalesce(prior.effective_until, 'infinity'::timestamptz) > ${input.effectiveFrom}::timestamptz
                and prior.effective_from < coalesce(${input.effectiveUntil ?? null}::timestamptz, 'infinity'::timestamptz)
           )
         returning rule.id, rule.product_id, rule.version_number,
                   rule.selling_price_minor_units, rule.minimum_deposit_minor_units,
                   rule.annual_rate_bps, rule.allowed_tenures_months,
                   rule.repayment_frequencies, rule.calculation_method,
                   rule.permitted_fees, rule.eligibility_policy,
                   rule.required_evidence, rule.exception_policy,
                   rule.disclosure_version, rule.fixture_hashes,
                   rule.licence_permitted, rule.approved, rule.requested_by,
                   rule.approved_by, rule.approved_at, rule.effective_from,
                   rule.effective_until, rule.published_at,
                   product.code as product_code, product.name as product_name,
                   product.vehicle_model_id
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("RULE_PUBLISH_REJECTED");
      return mapRule(row);
    },

    async findRule(ruleId: string): Promise<FinancingRuleRecord | null> {
      const result = await executor.execute<RuleRow>(ruleSelect(ruleId));
      return result.rows[0] === undefined ? null : mapRule(result.rows[0]);
    },

    async findEffectiveRule(
      productId: string,
      now: Date,
    ): Promise<FinancingRuleRecord | null> {
      const result = await executor.execute<RuleRow>(sql`
        ${ruleSelectBase}
         where rule.product_id = ${productId}::uuid
           and rule.approved = true
           and rule.licence_permitted = true
           and rule.effective_from <= ${now}
           and (rule.effective_until is null or rule.effective_until > ${now})
         order by rule.effective_from desc, rule.version_number desc
         limit 1
      `);
      return result.rows[0] === undefined ? null : mapRule(result.rows[0]);
    },

    async lockApplication(
      applicationId: string,
    ): Promise<ApplicationGateRecord | null> {
      const result = await executor.execute<{
        id: string;
        status: string;
        version: number;
        product_id: string | null;
        vehicle_model_id: string | null;
        applicant_person_id: string;
      }>(sql`
        select id, status, version, product_id, vehicle_model_id, applicant_person_id
          from application where id = ${applicationId}::uuid for update
      `);
      const row = result.rows[0];
      return row === undefined
        ? null
        : {
            id: row.id,
            status: row.status,
            version: row.version,
            productId: row.product_id,
            vehicleModelId: row.vehicle_model_id,
            applicantPersonId: row.applicant_person_id,
          };
    },

    async insertException(input: {
      id: string;
      applicationId: string;
      proposedValue: unknown;
      policyValue: unknown;
      reason: string;
      requestedBy: string;
      requiredApproverRole: string;
      expiresAt?: Date;
    }): Promise<ExceptionRecord> {
      const result = await executor.execute<ExceptionRow>(sql`
        insert into exception_request
          (id, application_id, proposed_value, policy_value, reason,
           required_approver_role, requested_by, expires_at)
        values (${input.id}::uuid, ${input.applicationId}::uuid,
                ${input.proposedValue}::jsonb, ${input.policyValue}::jsonb,
                ${input.reason}, ${input.requiredApproverRole},
                ${input.requestedBy}::uuid, ${input.expiresAt ?? null})
        returning id, application_id, proposed_value, policy_value, reason,
                  required_approver_role, requested_by, status, version,
                  decided_by, decided_at, expires_at
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("EXCEPTION_INSERT_FAILED");
      return mapException(row);
    },

    async findException(exceptionId: string): Promise<ExceptionRecord | null> {
      const result = await executor.execute<ExceptionRow>(sql`
        select id, application_id, proposed_value, policy_value, reason,
               required_approver_role, requested_by, status, version,
               decided_by, decided_at, expires_at
          from exception_request where id = ${exceptionId}::uuid
      `);
      return result.rows[0] === undefined
        ? null
        : mapException(result.rows[0]);
    },

    async findApprovedException(
      applicationId: string,
      now: Date,
    ): Promise<ExceptionRecord | null> {
      const result = await executor.execute<ExceptionRow>(sql`
        select id, application_id, proposed_value, policy_value, reason,
               required_approver_role, requested_by, status, version,
               decided_by, decided_at, expires_at
          from exception_request
         where application_id = ${applicationId}::uuid
           and status = 'APPROVED'
           and (expires_at is null or expires_at > ${now})
         order by decided_at desc nulls last, id desc
         limit 1
      `);
      return result.rows[0] === undefined
        ? null
        : mapException(result.rows[0]);
    },

    async decideException(input: {
      exceptionId: string;
      expectedVersion: number;
      actorStaffUserId: string;
      status: "APPROVED" | "REJECTED";
      reason: string;
      now: Date;
    }): Promise<ExceptionRecord> {
      const result = await executor.execute<ExceptionRow>(sql`
        update exception_request
           set status = ${input.status},
               decided_by = ${input.actorStaffUserId}::uuid,
               decided_at = ${input.now},
               decision_reason = ${input.reason},
               version = version + 1,
               updated_at = ${input.now}
         where id = ${input.exceptionId}::uuid
           and version = ${input.expectedVersion}
           and status = 'PENDING'
           and requested_by <> ${input.actorStaffUserId}::uuid
           and (expires_at is null or expires_at > ${input.now})
         returning id, application_id, proposed_value, policy_value, reason,
                   required_approver_role, requested_by, status, version,
                   decided_by, decided_at, expires_at
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("EXCEPTION_DECISION_REJECTED");
      await executor.execute(sql`
        insert into exception_decision
          (exception_request_id, version, status, decided_by, reason, decided_at)
        values (${row.id}::uuid, ${row.version}, ${input.status},
                ${input.actorStaffUserId}::uuid, ${input.reason}, ${input.now})
      `);
      return mapException(row);
    },

    async findOffer(applicationId: string): Promise<OfferRecord | null> {
      const result = await executor.execute<OfferRow>(sql`
        select o.id, o.application_id, o.status, o.version,
               o.accepted_version_id, o.accepted_at, o.accepted_hash,
               o.consent_at, o.expires_at, o.accepted_by_person_id,
               ov.id as offer_version_id, ov.version_number,
               ov.financing_rule_version_id, ov.principal_minor_units,
               ov.deposit_minor_units, ov.total_payable_minor_units,
               ov.terms, ov.canonical_hash
          from offer o
          left join offer_version ov on ov.id = o.accepted_version_id
             or (ov.offer_id = o.id and ov.version_number = o.version)
         where o.application_id = ${applicationId}::uuid
         order by ov.version_number desc nulls last
         limit 1
      `);
      return result.rows[0] === undefined ? null : mapOffer(result.rows[0]);
    },

    async findOfferById(offerId: string): Promise<OfferRecord | null> {
      const result = await executor.execute<OfferRow>(sql`
        select o.id, o.application_id, o.status, o.version,
               o.accepted_version_id, o.accepted_at, o.accepted_hash,
               o.consent_at, o.expires_at, o.accepted_by_person_id,
               ov.id as offer_version_id, ov.version_number,
               ov.financing_rule_version_id, ov.principal_minor_units,
               ov.deposit_minor_units, ov.total_payable_minor_units,
               ov.terms, ov.canonical_hash
          from offer o
          left join offer_version ov on ov.id = o.accepted_version_id
             or (ov.offer_id = o.id and ov.version_number = o.version)
         where o.id = ${offerId}::uuid
         order by ov.version_number desc nulls last
         limit 1
      `);
      return result.rows[0] === undefined ? null : mapOffer(result.rows[0]);
    },

    async insertOffer(input: {
      offerId: string;
      offerVersionId: string;
      applicationId: string;
      ruleId: string;
      principalMinor: bigint;
      depositMinor: bigint;
      totalPayableMinor: bigint;
      terms: Record<string, unknown>;
      canonicalHash: string;
      expiresAt: Date;
    }): Promise<OfferRecord> {
      await executor.execute(sql`
        insert into offer
          (id, application_id, status, version, expires_at)
        values (${input.offerId}::uuid, ${input.applicationId}::uuid, 'PENDING', 1, ${input.expiresAt})
      `);
      await executor.execute(sql`
        insert into offer_version
          (id, offer_id, financing_rule_version_id, version_number,
           principal_minor_units, deposit_minor_units, total_payable_minor_units,
           terms, canonical_hash)
        values (${input.offerVersionId}::uuid, ${input.offerId}::uuid,
                ${input.ruleId}::uuid, 1, ${input.principalMinor}::bigint,
                ${input.depositMinor}::bigint, ${input.totalPayableMinor}::bigint,
                ${input.terms}::jsonb, ${input.canonicalHash})
      `);
      const offer = await this.findOffer(input.applicationId);
      if (offer === null) throw new Error("OFFER_INSERT_FAILED");
      return offer;
    },

    async acceptOffer(input: {
      offerId: string;
      expectedVersion: number;
      personId: string;
      acceptedAt: Date;
      consentAt: Date;
      acceptedHash: string;
    }): Promise<OfferRecord> {
      const result = await executor.execute<OfferRow>(sql`
        update offer
           set status = 'ACCEPTED',
               accepted_version_id = (
                 select id from offer_version where offer_id = offer.id and version_number = offer.version
               ),
               accepted_at = ${input.acceptedAt},
               consent_at = ${input.consentAt},
               accepted_hash = ${input.acceptedHash},
               accepted_by_person_id = ${input.personId}::uuid,
               version = version + 1,
               updated_at = ${input.acceptedAt}
         where id = ${input.offerId}::uuid
           and version = ${input.expectedVersion}
           and status = 'PENDING'
           and expires_at > ${input.acceptedAt}
         returning id, application_id, status, version,
                   accepted_version_id, accepted_at, accepted_hash,
                   consent_at, expires_at, accepted_by_person_id,
                   null::uuid as offer_version_id, null::integer as version_number,
                   null::uuid as financing_rule_version_id,
                   null::bigint as principal_minor_units,
                   null::bigint as deposit_minor_units,
                   null::bigint as total_payable_minor_units,
                   null::jsonb as terms, null::text as canonical_hash
      `);
      const row = result.rows[0];
      if (row === undefined) throw new Error("OFFER_ACCEPT_REJECTED");
      const offer = await this.findOffer(row.application_id);
      if (offer === null) throw new Error("OFFER_ACCEPT_FAILED");
      return offer;
    },
  };
}

const ruleSelectBase = sql`
  select rule.id, rule.product_id, rule.version_number,
         rule.selling_price_minor_units, rule.minimum_deposit_minor_units,
         rule.annual_rate_bps, rule.allowed_tenures_months,
         rule.repayment_frequencies, rule.calculation_method,
         rule.permitted_fees, rule.eligibility_policy,
         rule.required_evidence, rule.exception_policy,
         rule.disclosure_version, rule.fixture_hashes,
         rule.licence_permitted, rule.approved, rule.requested_by,
         rule.approved_by, rule.approved_at, rule.effective_from,
         rule.effective_until, rule.published_at,
         product.code as product_code, product.name as product_name,
         product.vehicle_model_id
    from financing_rule_version rule
    join product on product.id = rule.product_id
`;

function ruleSelect(id: string) {
  return sql`${ruleSelectBase} where rule.id = ${id}::uuid limit 1`;
}

interface CommandRow extends Record<string, unknown> {
  id: string;
  scope: string;
  idempotency_key: string;
  command_type: string;
  payload_hash: string;
  response: Record<string, unknown>;
}

interface RuleRow extends Record<string, unknown> {
  id: string;
  product_id: string;
  product_code: string;
  product_name: string;
  vehicle_model_id: string;
  version_number: number;
  selling_price_minor_units: bigint;
  minimum_deposit_minor_units: bigint;
  annual_rate_bps: string | number;
  allowed_tenures_months: number[];
  repayment_frequencies: Array<"WEEKLY" | "MONTHLY">;
  calculation_method: string;
  permitted_fees: Record<string, unknown>;
  eligibility_policy: Record<string, unknown>;
  required_evidence: string[];
  exception_policy: Record<string, unknown>;
  disclosure_version: string | null;
  fixture_hashes: string[];
  licence_permitted: boolean;
  approved: boolean;
  requested_by: string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  effective_from: Date | string | null;
  effective_until: Date | string | null;
  published_at: Date | string | null;
}

interface ExceptionRow extends Record<string, unknown> {
  id: string;
  application_id: string;
  proposed_value: unknown;
  policy_value: unknown;
  reason: string;
  required_approver_role: string;
  requested_by: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  version: number;
  decided_by: string | null;
  decided_at: Date | string | null;
  expires_at: Date | string | null;
}

interface OfferRow extends Record<string, unknown> {
  id: string;
  application_id: string;
  status: "PENDING" | "EXPIRED" | "ACCEPTED" | "CANCELLED";
  version: number;
  accepted_version_id: string | null;
  accepted_at: Date | string | null;
  accepted_hash: string | null;
  consent_at: Date | string | null;
  expires_at: Date | string | null;
  accepted_by_person_id: string | null;
  offer_version_id: string | null;
  version_number: number | null;
  financing_rule_version_id: string | null;
  principal_minor_units: bigint | null;
  deposit_minor_units: bigint | null;
  total_payable_minor_units: bigint | null;
  terms: Record<string, unknown> | null;
  canonical_hash: string | null;
}

function mapCommand(row: CommandRow): FinancingCommandRecord {
  return {
    id: row.id,
    scope: row.scope,
    idempotencyKey: row.idempotency_key,
    commandType: row.command_type,
    payloadHash: row.payload_hash,
    response: row.response,
  };
}

function mapRule(row: RuleRow): FinancingRuleRecord {
  const method = row.calculation_method;
  if (method !== "FLAT_MARKUP" && method !== "REDUCING_BALANCE") {
    throw new Error("METHOD_NOT_SUPPORTED");
  }
  return {
    id: row.id,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    vehicleModelId: row.vehicle_model_id,
    versionNumber: row.version_number,
    sellingPriceMinor: BigInt(row.selling_price_minor_units),
    minimumDepositMinor: BigInt(row.minimum_deposit_minor_units),
    annualRateBps: Number(row.annual_rate_bps),
    allowedTenuresMonths: row.allowed_tenures_months,
    repaymentFrequencies: row.repayment_frequencies,
    calculationMethod: method,
    permittedFees: row.permitted_fees,
    eligibilityPolicy: row.eligibility_policy,
    requiredEvidence: row.required_evidence,
    exceptionPolicy: row.exception_policy,
    disclosureVersion: row.disclosure_version,
    fixtureHashes: row.fixture_hashes,
    licencePermitted: row.licence_permitted,
    approved: row.approved,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    approvedAt: toDate(row.approved_at),
    effectiveFrom: toDate(row.effective_from),
    effectiveUntil: toDate(row.effective_until),
    publishedAt: toDate(row.published_at),
  };
}

function mapException(row: ExceptionRow): ExceptionRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    proposedValue: row.proposed_value,
    policyValue: row.policy_value,
    reason: row.reason,
    requiredApproverRole: row.required_approver_role,
    requestedBy: row.requested_by,
    status: row.status,
    version: row.version,
    decidedBy: row.decided_by,
    decidedAt: toDate(row.decided_at),
    expiresAt: toDate(row.expires_at),
  };
}

function mapOffer(row: OfferRow): OfferRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    status: row.status,
    version: row.version,
    acceptedVersionId: row.accepted_version_id,
    acceptedAt: toDate(row.accepted_at),
    acceptedHash: row.accepted_hash,
    consentAt: toDate(row.consent_at),
    expiresAt: toDate(row.expires_at),
    acceptedByPersonId: row.accepted_by_person_id,
    offerVersion:
      row.offer_version_id === null ||
      row.version_number === null ||
      row.financing_rule_version_id === null ||
      row.principal_minor_units === null ||
      row.deposit_minor_units === null ||
      row.total_payable_minor_units === null ||
      row.terms === null
        ? null
        : {
            id: row.offer_version_id,
            versionNumber: row.version_number,
            financingRuleVersionId: row.financing_rule_version_id,
            principalMinor: BigInt(row.principal_minor_units),
            depositMinor: BigInt(row.deposit_minor_units),
            totalPayableMinor: BigInt(row.total_payable_minor_units),
            terms: row.terms,
            canonicalHash: row.canonical_hash,
          },
  };
}

function toDate(value: Date | string | null): Date | null {
  return value === null ? null : value instanceof Date ? value : new Date(value);
}
