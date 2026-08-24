import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFile } from "node:fs/promises";

export const REQUIRED_PILOT_GATES = Object.freeze([
  "licence",
  "legal",
  "privacy",
  "NIA",
  "SMS",
  "payment",
  "hosting",
  "finance-calculation",
  "restore",
  "security",
] as const);

export type PilotGateEnvironment = "development" | "production" | "test";

export interface PilotGateEvidence {
  gate: (typeof REQUIRED_PILOT_GATES)[number];
  environment: PilotGateEnvironment;
  issuedAt: string;
  expiresAt: string;
  evidence: unknown;
  evidenceHash: string;
  signature: string;
  keyId: string;
}

export interface PilotGateEvidenceDocument {
  environment: PilotGateEnvironment;
  gates: readonly PilotGateEvidence[];
}

export async function verifyPilotGates(options: {
  environment: PilotGateEnvironment;
  evidenceFile?: string;
  publicKey?: string;
  now?: Date;
}): Promise<{ environment: PilotGateEnvironment; synthetic: boolean }> {
  if (options.environment === "test") {
    const synthetic = createSyntheticEvidence(options.now ?? new Date());
    verifyEvidenceDocument(
      synthetic.document,
      synthetic.publicKey,
      "test",
      options.now,
    );
    return { environment: "test", synthetic: true };
  }
  if (options.evidenceFile === undefined || options.evidenceFile.trim() === "")
    throw new Error("PILOT_GATE_EVIDENCE_FILE_REQUIRED");
  if (options.publicKey === undefined || options.publicKey.trim() === "")
    throw new Error("PILOT_GATE_PUBLIC_KEY_REQUIRED");
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(options.evidenceFile, "utf8"),
    ) as unknown;
  } catch {
    throw new Error("PILOT_GATE_EVIDENCE_JSON_INVALID");
  }
  verifyEvidenceDocument(
    parsed as PilotGateEvidenceDocument,
    options.publicKey,
    options.environment,
    options.now,
  );
  return { environment: options.environment, synthetic: false };
}

export function verifyEvidenceDocument(
  document: PilotGateEvidenceDocument,
  publicKey: string,
  environment: PilotGateEnvironment,
  now = new Date(),
): void {
  if (document === null || typeof document !== "object")
    throw new Error("PILOT_GATE_EVIDENCE_INVALID");
  if (document.environment !== environment)
    throw new Error("PILOT_GATE_ENVIRONMENT_MISMATCH");
  if (!Array.isArray(document.gates))
    throw new Error("PILOT_GATE_EVIDENCE_INVALID");
  const seen = new Set<string>();
  const current = now.getTime();
  for (const gate of document.gates) {
    validateGate(gate);
    if (gate.environment !== environment)
      throw new Error("PILOT_GATE_ENVIRONMENT_MISMATCH");
    if (seen.has(gate.gate)) throw new Error("PILOT_GATE_DUPLICATE");
    seen.add(gate.gate);
    const issuedAt = Date.parse(gate.issuedAt);
    const expiresAt = Date.parse(gate.expiresAt);
    if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt))
      throw new Error("PILOT_GATE_DATE_INVALID");
    if (issuedAt > current || expiresAt <= current)
      throw new Error("PILOT_GATE_EXPIRED_OR_FUTURE");
    if (gate.evidenceHash !== sha256(canonicalJson(gate.evidence)))
      throw new Error("PILOT_GATE_EVIDENCE_HASH_MISMATCH");
    const payload = canonicalJson(stripSignature(gate));
    const signature = toCryptoBytes(gate.signature, "base64url");
    if (!verify(null, toCryptoBytes(payload), publicKey, signature))
      throw new Error("PILOT_GATE_SIGNATURE_INVALID");
  }
  for (const required of REQUIRED_PILOT_GATES) {
    if (!seen.has(required)) throw new Error(`PILOT_GATE_MISSING:${required}`);
  }
}

function createSyntheticEvidence(now: Date): {
  document: PilotGateEvidenceDocument;
  publicKey: string;
} {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1_000).toISOString();
  const gates = REQUIRED_PILOT_GATES.map((gate) => {
    const unsigned = {
      gate,
      environment: "test" as const,
      issuedAt,
      expiresAt,
      evidence: { synthetic: true, gate },
      evidenceHash: sha256(canonicalJson({ synthetic: true, gate })),
      keyId: "synthetic-ephemeral-ed25519",
    };
    return {
      ...unsigned,
      signature: sign(
        null,
        toCryptoBytes(canonicalJson(unsigned)),
        privateKey,
      ).toString("base64url"),
    };
  });
  return {
    document: { environment: "test", gates },
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}

function validateGate(gate: unknown): asserts gate is PilotGateEvidence {
  if (
    gate === null ||
    typeof gate !== "object" ||
    !REQUIRED_PILOT_GATES.includes((gate as PilotGateEvidence).gate) ||
    typeof (gate as PilotGateEvidence).environment !== "string" ||
    typeof (gate as PilotGateEvidence).issuedAt !== "string" ||
    typeof (gate as PilotGateEvidence).expiresAt !== "string" ||
    typeof (gate as PilotGateEvidence).evidenceHash !== "string" ||
    !/^[0-9a-f]{64}$/.test((gate as PilotGateEvidence).evidenceHash) ||
    typeof (gate as PilotGateEvidence).signature !== "string" ||
    (gate as PilotGateEvidence).signature.length === 0 ||
    typeof (gate as PilotGateEvidence).keyId !== "string" ||
    (gate as PilotGateEvidence).keyId.length === 0 ||
    !("evidence" in gate)
  ) {
    throw new Error("PILOT_GATE_EVIDENCE_INVALID");
  }
}

function stripSignature(
  gate: PilotGateEvidence,
): Omit<PilotGateEvidence, "signature"> {
  const { signature, ...unsigned } = gate;
  void signature;
  return unsigned;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => {
      const record = value as Record<string, unknown>;
      return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
    })
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toCryptoBytes(
  value: string,
  encoding: BufferEncoding = "utf8",
): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(
    Buffer.from(value, encoding),
  ) as Uint8Array<ArrayBuffer>;
}
