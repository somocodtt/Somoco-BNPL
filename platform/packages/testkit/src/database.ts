import { randomUUID } from "node:crypto";
import { Pool } from "pg";

export function requireTestDatabaseUrl(): string {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error(
      "TEST_DATABASE_URL is required for database integration tests",
    );
  }
  assertDisposableTestDatabaseUrl(databaseUrl);
  return databaseUrl;
}

export async function resetTestDatabase(
  connectionString: string,
): Promise<void> {
  const configuredUrl = requireTestDatabaseUrl();
  if (connectionString !== configuredUrl) {
    throw new Error("Reset target must exactly match TEST_DATABASE_URL");
  }

  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query("drop schema if exists public cascade");
    await pool.query("drop schema if exists privacy cascade");
    await pool.query("drop schema if exists drizzle cascade");
    await pool.query("create schema public");
  } finally {
    await pool.end();
  }
}

export async function executeTestSql(
  connectionString: string,
  text: string,
  values: unknown[] = [],
): Promise<void> {
  assertExactTestDatabaseUrl(connectionString, "Execute");
  await withPool(async (pool) => {
    await pool.query(text, values);
  });
}

export async function queryTestSql<T>(
  connectionString: string,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  assertExactTestDatabaseUrl(connectionString, "Query");
  return withPool(async (pool) => {
    const result = await pool.query<Record<string, unknown>>(text, values);
    const row = result.rows[0];
    if (row === undefined) throw new Error("TEST_ROW_NOT_FOUND");
    return row as T;
  });
}

export async function seedSyntheticPerson(
  connectionString: string,
  input: { phoneE164: string },
): Promise<{ id: string; phoneE164: string }> {
  const configuredUrl = requireTestDatabaseUrl();
  if (connectionString !== configuredUrl) {
    throw new Error("Seed target must exactly match TEST_DATABASE_URL");
  }
  const id = randomUUID();
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      "insert into privacy.person (id, phone_e164) values ($1, $2)",
      [id, input.phoneE164],
    );
    return { id, phoneE164: input.phoneE164 };
  } finally {
    await pool.end();
  }
}

export async function readLatestOtpChallenge(
  connectionString: string,
  personId: string,
): Promise<{ id: string; codeHash: string } | null> {
  const configuredUrl = requireTestDatabaseUrl();
  if (connectionString !== configuredUrl) {
    throw new Error("Read target must exactly match TEST_DATABASE_URL");
  }
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{ id: string; code_hash: string }>(
      `select id, code_hash
         from privacy.otp_challenge
        where person_id = $1
        order by created_at desc
        limit 1`,
      [personId],
    );
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id, codeHash: row.code_hash };
  } finally {
    await pool.end();
  }
}

export async function readOtpRequestWorkEvidence(
  connectionString: string,
  requestId: string,
): Promise<{ auditCount: number; outboxCount: number }> {
  assertExactTestDatabaseUrl(connectionString, "Read");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const audit = await pool.query<{ count: string }>(
      `select count(*)::text as count from audit_event where request_id = $1`,
      [requestId],
    );
    const outbox = await pool.query<{ count: string }>(
      `select count(*)::text as count
         from outbox_message
        where payload->>'requestId' = $1`,
      [requestId],
    );
    return {
      auditCount: Number(audit.rows[0]!.count),
      outboxCount: Number(outbox.rows[0]!.count),
    };
  } finally {
    await pool.end();
  }
}

export async function readOtpDeliveryPayloads(
  connectionString: string,
): Promise<unknown[]> {
  assertExactTestDatabaseUrl(connectionString, "Read");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{ payload: unknown }>(
      `select o.payload
         from outbox_message o
         join privacy.otp_challenge c
           on c.id = (o.payload->>'challengeId')::uuid
        where o.topic = 'identity.otp_sms_requested'
        order by o.occurred_at, o.created_at, o.id`,
    );
    return result.rows.map((row) => row.payload);
  } finally {
    await pool.end();
  }
}

export async function expireIdentityCheckProcessingLease(
  connectionString: string,
  identityCheckId: string,
): Promise<void> {
  assertExactTestDatabaseUrl(connectionString, "Mutate");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    await pool.query(
      `update privacy.identity_check
          set processing_token = $2,
              processing_started_at = now() - interval '5 minutes'
        where id = $1`,
      [identityCheckId, randomUUID()],
    );
  } finally {
    await pool.end();
  }
}

export async function seedSyntheticDraft(
  connectionString: string,
  input: { personId: string },
): Promise<{ id: string; status: string }> {
  assertExactTestDatabaseUrl(connectionString, "Seed");
  const id = randomUUID();
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{ id: string; status: string }>(
      `insert into application (id, applicant_person_id)
       values ($1, $2)
       returning id, status`,
      [id, input.personId],
    );
    return result.rows[0]!;
  } finally {
    await pool.end();
  }
}

export async function readSyntheticDraft(
  connectionString: string,
  draftId: string,
): Promise<{ id: string; status: string; version: number } | null> {
  assertExactTestDatabaseUrl(connectionString, "Read");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{
      id: string;
      status: string;
      version: number;
    }>(
      `select id, status, version
         from application
        where id = $1`,
      [draftId],
    );
    return result.rows[0] ?? null;
  } finally {
    await pool.end();
  }
}

export async function readIdentityChecks(
  connectionString: string,
  personId: string,
): Promise<
  Array<{
    id: string;
    personId: string;
    provider: string;
    providerReference: string | null;
    consentEvidenceId: string | null;
    idempotencyKey: string | null;
    status: string;
    evidence: Record<string, unknown>;
    checkedAt: Date;
  }>
> {
  assertExactTestDatabaseUrl(connectionString, "Read");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{
      id: string;
      person_id: string;
      provider: string;
      provider_reference: string | null;
      consent_evidence_id: string | null;
      idempotency_key: string | null;
      status: string;
      evidence: Record<string, unknown>;
      checked_at: Date;
    }>(
      `select id, person_id, provider, provider_reference, consent_evidence_id,
              idempotency_key, status, evidence,
              checked_at
         from privacy.identity_check
        where person_id = $1
        order by created_at, id`,
      [personId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      personId: row.person_id,
      provider: row.provider,
      providerReference: row.provider_reference,
      consentEvidenceId: row.consent_evidence_id,
      idempotencyKey: row.idempotency_key,
      status: row.status,
      evidence: row.evidence,
      checkedAt: row.checked_at,
    }));
  } finally {
    await pool.end();
  }
}

export async function readConsentEvidence(
  connectionString: string,
  personId: string,
): Promise<
  Array<{
    id: string;
    personId: string;
    purpose: string;
    documentVersion: string;
    evidence: Record<string, unknown>;
    acceptedAt: Date;
  }>
> {
  assertExactTestDatabaseUrl(connectionString, "Read");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{
      id: string;
      person_id: string;
      purpose: string;
      policy_version: string;
      evidence: Record<string, unknown>;
      consented_at: Date;
    }>(
      `select id, person_id, purpose, policy_version, evidence, consented_at
         from privacy.consent_evidence
        where person_id = $1
        order by consented_at, id`,
      [personId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      personId: row.person_id,
      purpose: row.purpose,
      documentVersion: row.policy_version,
      evidence: row.evidence,
      acceptedAt: row.consented_at,
    }));
  } finally {
    await pool.end();
  }
}

export async function attemptConsentEvidenceMutation(
  connectionString: string,
  consentId: string,
  operation: "UPDATE" | "DELETE",
): Promise<string | undefined> {
  assertExactTestDatabaseUrl(connectionString, "Mutation");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    try {
      if (operation === "UPDATE") {
        await pool.query(
          `update privacy.consent_evidence
              set policy_version = 'tampered'
            where id = $1`,
          [consentId],
        );
      } else {
        await pool.query(`delete from privacy.consent_evidence where id = $1`, [
          consentId,
        ]);
      }
      return undefined;
    } catch (error) {
      return databaseErrorCode(error);
    }
  } finally {
    await pool.end();
  }
}

export async function attemptAcceptedDocumentMutation(
  connectionString: string,
  documentId: string,
  operation: "UPDATE" | "DELETE",
): Promise<string | undefined> {
  assertExactTestDatabaseUrl(connectionString, "Mutation");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    try {
      if (operation === "UPDATE") {
        await pool.query(
          `update privacy.document
              set metadata = metadata || '{"tampered":true}'::jsonb
            where id = $1`,
          [documentId],
        );
      } else {
        await pool.query(`delete from privacy.document where id = $1`, [
          documentId,
        ]);
      }
      return undefined;
    } catch (error) {
      return databaseErrorCode(error);
    }
  } finally {
    await pool.end();
  }
}

export async function readAuditEventsForAggregate(
  connectionString: string,
  aggregateType: string,
  aggregateId: string,
): Promise<Array<{ action: string; data: Record<string, unknown> }>> {
  assertExactTestDatabaseUrl(connectionString, "Read");
  const pool = new Pool({ connectionString, max: 1 });
  try {
    const result = await pool.query<{
      action: string;
      data: Record<string, unknown>;
    }>(
      `select action, data
         from audit_event
        where aggregate_type = $1 and aggregate_id = $2
        order by recorded_at, id`,
      [aggregateType, aggregateId],
    );
    return result.rows;
  } finally {
    await pool.end();
  }
}

function assertExactTestDatabaseUrl(
  connectionString: string,
  operation: string,
): void {
  const configuredUrl = requireTestDatabaseUrl();
  if (connectionString !== configuredUrl) {
    throw new Error(`${operation} target must exactly match TEST_DATABASE_URL`);
  }
}

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

function assertDisposableTestDatabaseUrl(connectionString: string): void {
  let databaseUrl: URL;
  try {
    databaseUrl = new URL(connectionString);
  } catch {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  if (!["postgres:", "postgresql:"].includes(databaseUrl.protocol)) {
    throw new Error("TEST_DATABASE_URL must be a valid PostgreSQL URL");
  }

  const databaseName = decodeURIComponent(databaseUrl.pathname.slice(1));
  if (!databaseName.toLowerCase().endsWith("_test")) {
    throw new Error(
      "TEST_DATABASE_URL must name a disposable test database ending in _test",
    );
  }
}

async function withPool<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 1 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}
