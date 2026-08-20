import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { requireTestDatabaseUrl } from "./database.js";

export async function seedApplicationOnboardingFixtures(): Promise<{
  applicantId: string;
  guarantorId: string;
  otherId: string;
  vehicleModelId: string;
}> {
  const applicantId = randomUUID();
  const guarantorId = randomUUID();
  const otherId = randomUUID();
  const vehicleModelId = randomUUID();
  await withPool(async (pool) => {
    await pool.query(
      `insert into privacy.person (id, phone_e164) values
       ($1, '+233241000001'), ($2, '+233241000002'), ($3, '+233241000003')`,
      [applicantId, guarantorId, otherId],
    );
    await pool.query(
      `insert into vehicle_model (id, manufacturer, model_name, model_year, active)
       values ($1, 'Synthetic Motors', 'Pilot Bike', 2026, true)`,
      [vehicleModelId],
    );
  });
  return { applicantId, guarantorId, otherId, vehicleModelId };
}

export async function seedVerifiedIdentity(personId: string): Promise<void> {
  await execute(
    `insert into privacy.identity_check
      (id, person_id, provider, idempotency_key, provider_correlation_id,
       provider_reference, status, evidence, checked_at)
     values ($1, $2, 'NIA', $3, $4, $5, 'VERIFIED', '{}', now())`,
    [randomUUID(), personId, randomUUID(), randomUUID(), randomUUID()],
  );
}

export async function seedCleanDocument(
  personId: string,
  documentType: string,
): Promise<void> {
  const id = randomUUID();
  await execute(
    `insert into privacy.document
      (id, person_id, document_type, object_key, declared_mime_type,
       declared_size_bytes, upload_ticket_hash, upload_expires_at,
       accepted_object_key, accepted_object_version_id, accepted_object_etag,
       sha256, status, malware_scanned)
     values ($1, $2, $3, $4, 'image/jpeg', 128,
       repeat('a', 64), now() + interval '5 minutes', $5, 'v1', 'etag',
       repeat('b', 64), 'ACCEPTED', true)`,
    [id, personId, documentType, `pending/${id}`, `accepted/${id}`],
  );
}

export async function readApplicationRow<T>(
  text: string,
  values: unknown[],
): Promise<T> {
  return withPool(async (pool) => {
    const result = await pool.query(text, values);
    if (result.rows[0] === undefined) throw new Error("TEST_ROW_NOT_FOUND");
    return result.rows[0] as T;
  });
}

export async function attemptApplicationVersionMutation(
  applicationId: string,
): Promise<string | undefined> {
  return withPool(async (pool) => {
    try {
      await pool.query(
        `update application_version set snapshot = '{}'::jsonb where application_id = $1`,
        [applicationId],
      );
      return undefined;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        return typeof error.code === "string" ? error.code : undefined;
      }
      return undefined;
    }
  });
}

async function execute(text: string, values: unknown[]): Promise<void> {
  await withPool(async (pool) => {
    await pool.query(text, values);
  });
}

async function withPool<T>(operation: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: requireTestDatabaseUrl(), max: 1 });
  try {
    return await operation(pool);
  } finally {
    await pool.end();
  }
}
