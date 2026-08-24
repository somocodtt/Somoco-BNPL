import { randomUUID } from "node:crypto";
import { AppError } from "../../plugins/errors.js";

export {
  createPostgresPrivacyService,
  isDurablePrivacyService,
} from "./postgres-service.js";

export type PrivacySubjectType = "APPLICANT" | "GUARANTOR";
export type PrivacyRequestType = "ACCESS" | "CORRECTION" | "RESTRICTION";
export type PrivacyRequestStatus =
  "OPEN" | "IN_REVIEW" | "COMPLETED" | "REJECTED" | "CLOSED";

export interface PrivacyActor {
  id: string;
  role?: string;
}

export interface PrivacyRequest {
  id: string;
  subjectId: string;
  subjectType: PrivacySubjectType;
  requestType: PrivacyRequestType;
  status: PrivacyRequestStatus;
  requestedBy: string;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PrivacyCorrection {
  id: string;
  subjectId: string;
  field: string;
  proposedValue: unknown;
  reason: string;
  version: number;
  recordedBy: string;
  recordedAt: string;
}

export interface PrivacyRestriction {
  id: string;
  subjectId: string;
  reason: string;
  requestedBy: string;
  createdAt: string;
  releasedAt: string | null;
}

export interface PrivacyExport {
  subjectId: string;
  profile: Record<string, unknown>;
  restrictions: readonly PrivacyRestriction[];
  corrections: readonly PrivacyCorrection[];
}

export interface PrivacyService {
  openRequest(input: OpenPrivacyRequestInput): Promise<PrivacyRequest>;
  listRequests(input?: {
    subjectId?: string;
    status?: PrivacyRequestStatus;
    actor?: PrivacyActor;
  }): Promise<readonly PrivacyRequest[]>;
  reviewRequest(input: {
    requestId: string;
    actor: PrivacyActor;
  }): Promise<PrivacyRequest>;
  closeRequest(input: {
    requestId: string;
    actor: PrivacyActor;
    outcome?: "COMPLETED" | "REJECTED";
  }): Promise<PrivacyRequest>;
  exportSubjectData(input: {
    requestId: string;
    subjectId: string;
  }): Promise<PrivacyExport>;
  recordCorrection(input: RecordCorrectionInput): Promise<PrivacyCorrection>;
  restrictProcessing(
    input: RestrictProcessingInput,
  ): Promise<PrivacyRestriction>;
  placeLegalHold(input: {
    subjectId: string;
    reason: string;
    actor: PrivacyActor;
  }): Promise<{ subjectId: string; reason: string; placedAt: string }>;
  releaseLegalHold(input: {
    subjectId: string;
    actor: PrivacyActor;
  }): Promise<{ subjectId: string; releasedAt: string }>;
  approveRetentionPolicy(input: {
    version: string;
    retentionDays: number;
    actor: PrivacyActor;
  }): Promise<RetentionPolicy>;
  applyRetention(input: {
    policyVersion: string;
    asOf?: Date;
    actor: PrivacyActor;
  }): Promise<RetentionResult>;
}

export interface OpenPrivacyRequestInput {
  subjectId: string;
  subjectType: PrivacySubjectType;
  requestType: PrivacyRequestType;
  requestedBy?: string;
  reason?: string;
}

export interface RecordCorrectionInput {
  requestId: string;
  subjectId: string;
  field: string;
  proposedValue: unknown;
  reason: string;
  actor: PrivacyActor;
}

export interface RestrictProcessingInput {
  requestId: string;
  subjectId: string;
  reason: string;
  actor: PrivacyActor;
}

export interface RetentionPolicy {
  version: string;
  retentionDays: number;
  approvedBy: string;
  approvedAt: string;
}

export interface RetentionResult {
  policyVersion: string;
  evaluated: number;
  anonymized: number;
  retained: number;
  skippedLegalHold: number;
  immutableEvidenceRetained: number;
}

interface SubjectRecord {
  createdAt: string;
  corrections: PrivacyCorrection[];
  restrictions: PrivacyRestriction[];
  legalHold: { reason: string; placedAt: string } | null;
  anonymizedAt: string | null;
}

export interface PrivacyServiceOptions {
  subjectData?: (
    subjectId: string,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
  now?: () => Date;
  subjectIds?: readonly string[];
}

const testOnlyInMemoryPrivacyServices = new WeakSet<object>();

export function isTestOnlyInMemoryPrivacyService(
  service: PrivacyService,
): boolean {
  return testOnlyInMemoryPrivacyServices.has(service);
}

const complianceRoles = new Set(["COMPLIANCE_OFFICER", "DPO"]);
const privacyReadRoles = new Set([...complianceRoles, "COMPLIANCE_AUDITOR"]);

const correctionFieldPattern = /^[a-z][A-Za-z0-9_]{0,63}$/;
const immutableFieldPattern =
  /(?:ledger|payment|approval|audit|contract|signature|identity.?check|financial|amount|balance|decision)/i;
const sensitiveKeyPattern =
  /(?:otp|password|secret|token|authorization|cookie|session|mfa|code|private.?key)/i;

/** Test-only Map implementation. Production composition rejects this capability. */
export function createPrivacyService(
  options: PrivacyServiceOptions = {},
): PrivacyService {
  const now = options.now ?? (() => new Date());
  const subjectData: NonNullable<PrivacyServiceOptions["subjectData"]> =
    options.subjectData ??
    ((subjectId: string): Record<string, unknown> => ({ subjectId }));
  const requests = new Map<string, PrivacyRequest>();
  const subjects = new Map<string, SubjectRecord>();
  const policies = new Map<string, RetentionPolicy>();
  for (const subjectId of options.subjectIds ?? [])
    ensureSubject(subjects, subjectId, now().toISOString());

  const service: PrivacyService = {
    async openRequest(input) {
      assertSubjectId(input.subjectId);
      if (!isRequestType(input.requestType))
        throw privacyError("PRIVACY_REQUEST_TYPE_INVALID", 400);
      const createdAt = now().toISOString();
      const request: PrivacyRequest = {
        id: randomUUID(),
        subjectId: input.subjectId,
        subjectType: input.subjectType,
        requestType: input.requestType,
        status: "OPEN",
        requestedBy: input.requestedBy ?? input.subjectId,
        reason: input.reason?.trim() || null,
        createdAt,
        updatedAt: createdAt,
      };
      requests.set(request.id, request);
      ensureSubject(subjects, request.subjectId, createdAt);
      return request;
    },

    async listRequests(input = {}) {
      if (input.actor !== undefined || input.subjectId === undefined) {
        assertPrivacyReadActor(input.actor);
      }
      return [...requests.values()].filter(
        (request) =>
          (input.subjectId === undefined ||
            request.subjectId === input.subjectId) &&
          (input.status === undefined || request.status === input.status),
      );
    },

    async reviewRequest(input) {
      assertComplianceActor(input.actor);
      const request = getRequest(requests, input.requestId);
      assertRequestMutable(request);
      const updated = {
        ...request,
        status: "IN_REVIEW" as const,
        updatedAt: now().toISOString(),
      };
      requests.set(updated.id, updated);
      return updated;
    },

    async closeRequest(input) {
      assertComplianceActor(input.actor);
      const request = getRequest(requests, input.requestId);
      assertRequestMutable(request);
      const updated = {
        ...request,
        status: input.outcome ?? "COMPLETED",
        updatedAt: now().toISOString(),
      } satisfies PrivacyRequest;
      requests.set(updated.id, updated);
      return updated;
    },

    async exportSubjectData(input) {
      const request = getRequest(requests, input.requestId);
      if (
        request.requestType !== "ACCESS" ||
        request.subjectId !== input.subjectId
      )
        throw privacyError("PRIVACY_EXPORT_NOT_AUTHORIZED", 403);
      if (request.status === "REJECTED" || request.status === "CLOSED")
        throw privacyError("PRIVACY_EXPORT_NOT_AUTHORIZED", 403);
      const record = ensureSubject(subjects, input.subjectId);
      if (record.anonymizedAt !== null) {
        return {
          subjectId: input.subjectId,
          profile: {
            anonymized: true,
            anonymizedAt: record.anonymizedAt,
          },
          restrictions: [],
          corrections: [],
        };
      }
      const raw = await subjectData(input.subjectId);
      const profile =
        raw.profile !== null &&
        typeof raw.profile === "object" &&
        !Array.isArray(raw.profile)
          ? (raw.profile as Record<string, unknown>)
          : raw;
      return {
        subjectId: input.subjectId,
        profile: redactExport(profile),
        restrictions: record.restrictions.map((item) => ({ ...item })),
        corrections: record.corrections.map((item) => ({ ...item })),
      };
    },

    async recordCorrection(input) {
      assertComplianceActor(input.actor);
      const request = getRequest(requests, input.requestId);
      if (
        request.requestType !== "CORRECTION" ||
        request.subjectId !== input.subjectId
      )
        throw privacyError("PRIVACY_CORRECTION_NOT_AUTHORIZED", 403);
      assertRequestMutable(request);
      if (!correctionFieldPattern.test(input.field))
        throw privacyError("PRIVACY_CORRECTION_FIELD_INVALID", 400);
      if (immutableFieldPattern.test(input.field))
        throw privacyError("PRIVACY_IMMUTABLE_EVIDENCE", 409);
      if (input.reason.trim() === "")
        throw privacyError("PRIVACY_CORRECTION_REASON_REQUIRED", 400);
      const record = ensureSubject(subjects, input.subjectId);
      const correction: PrivacyCorrection = {
        id: randomUUID(),
        subjectId: input.subjectId,
        field: input.field,
        proposedValue: cloneSafe(input.proposedValue),
        reason: input.reason.trim(),
        version:
          record.corrections.filter((item) => item.field === input.field)
            .length + 1,
        recordedBy: input.actor.id,
        recordedAt: now().toISOString(),
      };
      record.corrections.push(correction);
      return { ...correction };
    },

    async restrictProcessing(input) {
      assertComplianceActor(input.actor);
      const request = getRequest(requests, input.requestId);
      if (
        request.requestType !== "RESTRICTION" ||
        request.subjectId !== input.subjectId
      )
        throw privacyError("PRIVACY_RESTRICTION_NOT_AUTHORIZED", 403);
      assertRequestMutable(request);
      if (input.reason.trim() === "")
        throw privacyError("PRIVACY_RESTRICTION_REASON_REQUIRED", 400);
      const record = ensureSubject(subjects, input.subjectId);
      const restriction: PrivacyRestriction = {
        id: randomUUID(),
        subjectId: input.subjectId,
        reason: input.reason.trim(),
        requestedBy: input.actor.id,
        createdAt: now().toISOString(),
        releasedAt: null,
      };
      record.restrictions.push(restriction);
      return { ...restriction };
    },

    async placeLegalHold(input) {
      assertComplianceActor(input.actor);
      assertSubjectId(input.subjectId);
      if (input.reason.trim() === "")
        throw privacyError("PRIVACY_LEGAL_HOLD_REASON_REQUIRED", 400);
      const placedAt = now().toISOString();
      ensureSubject(subjects, input.subjectId).legalHold = {
        reason: input.reason.trim(),
        placedAt,
      };
      return {
        subjectId: input.subjectId,
        reason: input.reason.trim(),
        placedAt,
      };
    },

    async releaseLegalHold(input) {
      assertComplianceActor(input.actor);
      const record = ensureSubject(subjects, input.subjectId);
      record.legalHold = null;
      return { subjectId: input.subjectId, releasedAt: now().toISOString() };
    },

    async approveRetentionPolicy(input) {
      assertComplianceActor(input.actor);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.version))
        throw privacyError("PRIVACY_RETENTION_POLICY_INVALID", 400);
      if (!Number.isSafeInteger(input.retentionDays) || input.retentionDays < 1)
        throw privacyError("PRIVACY_RETENTION_POLICY_INVALID", 400);
      const existing = policies.get(input.version);
      if (existing !== undefined) {
        if (existing.retentionDays !== input.retentionDays) {
          throw privacyError("PRIVACY_RETENTION_POLICY_IMMUTABLE", 409);
        }
        return existing;
      }
      const policy: RetentionPolicy = {
        version: input.version,
        retentionDays: input.retentionDays,
        approvedBy: input.actor.id,
        approvedAt: now().toISOString(),
      };
      policies.set(policy.version, policy);
      return policy;
    },

    async applyRetention(input) {
      assertComplianceActor(input.actor);
      const policy = policies.get(input.policyVersion);
      if (policy === undefined)
        throw privacyError("PRIVACY_RETENTION_POLICY_NOT_APPROVED", 409);
      const asOf = input.asOf ?? now();
      let anonymized = 0;
      let retained = 0;
      let skippedLegalHold = 0;
      for (const record of subjects.values()) {
        if (record.legalHold !== null) {
          skippedLegalHold += 1;
          continue;
        }
        if (record.anonymizedAt !== null) {
          retained += 1;
          continue;
        }
        const latestActivity =
          record.corrections.at(-1)?.recordedAt ?? record.createdAt;
        if (
          latestActivity === undefined ||
          asOf.getTime() - new Date(latestActivity).getTime() <
            policy.retentionDays * 24 * 60 * 60 * 1_000
        ) {
          retained += 1;
          continue;
        }
        record.anonymizedAt = asOf.toISOString();
        anonymized += 1;
      }
      return {
        policyVersion: policy.version,
        evaluated: subjects.size,
        anonymized,
        retained,
        skippedLegalHold,
        immutableEvidenceRetained: subjects.size,
      };
    },
  };
  testOnlyInMemoryPrivacyServices.add(service);
  return service;
}

function ensureSubject(
  subjects: Map<string, SubjectRecord>,
  subjectId: string,
  createdAt = new Date().toISOString(),
): SubjectRecord {
  const existing = subjects.get(subjectId);
  if (existing !== undefined) return existing;
  const created: SubjectRecord = {
    createdAt,
    corrections: [],
    restrictions: [],
    legalHold: null,
    anonymizedAt: null,
  };
  subjects.set(subjectId, created);
  return created;
}

function getRequest(
  requests: Map<string, PrivacyRequest>,
  requestId: string,
): PrivacyRequest {
  const request = requests.get(requestId);
  if (request === undefined)
    throw privacyError("PRIVACY_REQUEST_NOT_FOUND", 404);
  return request;
}

function assertRequestMutable(request: PrivacyRequest): void {
  if (
    request.status === "COMPLETED" ||
    request.status === "REJECTED" ||
    request.status === "CLOSED"
  ) {
    throw privacyError("PRIVACY_REQUEST_TERMINAL", 409);
  }
}

function assertSubjectId(value: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw privacyError("PRIVACY_SUBJECT_INVALID", 400);
}

function assertComplianceActor(actor: PrivacyActor | undefined): void {
  if (
    actor === undefined ||
    !actor.id.trim() ||
    !complianceRoles.has(actor.role?.toUpperCase() ?? "")
  )
    throw privacyError("PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED", 403);
}

function assertPrivacyReadActor(actor: PrivacyActor | undefined): void {
  if (
    actor === undefined ||
    !actor.id.trim() ||
    !privacyReadRoles.has(actor.role?.toUpperCase() ?? "")
  )
    throw privacyError("PRIVACY_COMPLIANCE_AUTHORIZATION_REQUIRED", 403);
}

function isRequestType(value: string): value is PrivacyRequestType {
  return (
    value === "ACCESS" || value === "CORRECTION" || value === "RESTRICTION"
  );
}

function privacyError(code: string, status: number): AppError {
  return new AppError(
    status,
    code,
    "The privacy request could not be processed.",
  );
}

function redactExport(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (sensitiveKeyPattern.test(key)) continue;
    result[key] = redactExportValue(item);
  }
  return result;
}

function redactExportValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactExportValue);
  if (value !== null && typeof value === "object") {
    return redactExport(value as Record<string, unknown>);
  }
  return value;
}

function cloneSafe(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as unknown;
}
