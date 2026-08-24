import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const REQUIRED_GATES = Object.freeze([
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
]);

const signatureEncoding = "base64url";
const sha256Pattern = /^[0-9a-f]{64}$/;

const args = parseArgs(process.argv.slice(2));
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  verifyFromEnvironment(args).then(
    () => {
      process.stdout.write(
        `pilot gates verified: ${args.environment} (${REQUIRED_GATES.length} signed gates)\n`,
      );
    },
    (error) => {
      process.stderr.write(
        `pilot gate verification failed: ${safeErrorMessage(error)}\n`,
      );
      process.exitCode = 1;
    },
  );
}

export async function verifyFromEnvironment(options = {}) {
  const environment = options.environment ?? "production";
  if (environment === "test") {
    const synthetic = createSyntheticEvidence();
    verifyEvidenceDocument(synthetic, synthetic.publicKey, "test");
    return Object.freeze({ environment, synthetic: true });
  }
  if (environment !== "production" && environment !== "development") {
    throw new Error("PILOT_GATE_ENVIRONMENT_INVALID");
  }
  const file = options.evidenceFile ?? process.env.PILOT_GATE_EVIDENCE_FILE;
  const publicKey = options.publicKey ?? process.env.PILOT_GATE_PUBLIC_KEY_PEM;
  if (file === undefined || file.trim() === "")
    throw new Error("PILOT_GATE_EVIDENCE_FILE_REQUIRED");
  if (publicKey === undefined || publicKey.trim() === "")
    throw new Error("PILOT_GATE_PUBLIC_KEY_REQUIRED");
  const document = parseDocument(await readFile(file, "utf8"));
  verifyEvidenceDocument(document, publicKey, environment);
  return Object.freeze({ environment, synthetic: false });
}

export function verifyEvidenceDocument(
  document,
  publicKey,
  environment,
  now = new Date(),
) {
  if (document.environment !== environment)
    throw new Error("PILOT_GATE_ENVIRONMENT_MISMATCH");
  if (!Array.isArray(document.gates))
    throw new Error("PILOT_GATE_EVIDENCE_INVALID");
  const seen = new Set();
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
    const expectedEvidenceHash = sha256(canonicalJson(gate.evidence));
    if (gate.evidenceHash !== expectedEvidenceHash)
      throw new Error("PILOT_GATE_EVIDENCE_HASH_MISMATCH");
    const signedPayload = canonicalJson(stripSignature(gate));
    let signature;
    try {
      signature = Buffer.from(gate.signature, signatureEncoding);
    } catch {
      throw new Error("PILOT_GATE_SIGNATURE_INVALID");
    }
    if (!verify(null, Buffer.from(signedPayload), publicKey, signature))
      throw new Error("PILOT_GATE_SIGNATURE_INVALID");
  }
  for (const required of REQUIRED_GATES) {
    if (!seen.has(required)) throw new Error(`PILOT_GATE_MISSING:${required}`);
  }
  return true;
}

function createSyntheticEvidence(now = new Date()) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1_000).toISOString();
  const gates = REQUIRED_GATES.map((gate) => {
    const unsigned = {
      gate,
      environment: "test",
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
        Buffer.from(canonicalJson(unsigned)),
        privateKey,
      ).toString(signatureEncoding),
    };
  });
  return {
    environment: "test",
    gates,
    publicKey: publicKey.export({ type: "spki", format: "pem" }),
  };
}

function validateGate(gate) {
  if (
    gate === null ||
    typeof gate !== "object" ||
    !REQUIRED_GATES.includes(gate.gate) ||
    typeof gate.environment !== "string" ||
    typeof gate.issuedAt !== "string" ||
    typeof gate.expiresAt !== "string" ||
    typeof gate.evidenceHash !== "string" ||
    !sha256Pattern.test(gate.evidenceHash) ||
    typeof gate.signature !== "string" ||
    gate.signature.length === 0 ||
    typeof gate.keyId !== "string" ||
    gate.keyId.length === 0 ||
    !("evidence" in gate)
  ) {
    throw new Error("PILOT_GATE_EVIDENCE_INVALID");
  }
}

function stripSignature(gate) {
  const unsigned = { ...gate };
  delete unsigned.signature;
  return unsigned;
}

function parseDocument(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("PILOT_GATE_EVIDENCE_JSON_INVALID");
  }
}

function parseArgs(values) {
  const environmentIndex = values.indexOf("--environment");
  const environment =
    environmentIndex >= 0 ? values[environmentIndex + 1] : undefined;
  const evidenceIndex = values.indexOf("--evidence-file");
  const evidenceFile =
    evidenceIndex >= 0 ? values[evidenceIndex + 1] : undefined;
  return {
    environment: environment ?? "production",
    ...(evidenceFile === undefined ? {} : { evidenceFile }),
  };
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeErrorMessage(error) {
  if (error instanceof Error) return error.message;
  return "PILOT_GATE_VERIFICATION_FAILED";
}
