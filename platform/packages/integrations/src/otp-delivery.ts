import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

export interface OtpDeliveryEnvelope {
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
  authenticationTag: string;
}

export interface OtpDelivery {
  phoneE164: string;
  template: "CUSTOMER_AUTHENTICATION_OTP";
  variables: { code: string };
}

export function sealOtpDelivery(
  secret: string,
  delivery: OtpDelivery,
): OtpDeliveryEnvelope {
  const validated = validateDelivery(delivery);
  const iv = Uint8Array.from(randomBytes(12));
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(secret), iv);
  const ciphertext =
    cipher.update(JSON.stringify(validated), "utf8", "base64url") +
    cipher.final("base64url");
  return Object.freeze({
    algorithm: "A256GCM" as const,
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext,
    authenticationTag: cipher.getAuthTag().toString("base64url"),
  });
}

export function openOtpDelivery(secret: string, value: unknown): OtpDelivery {
  const envelope = validateEnvelope(value);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(secret),
      Uint8Array.from(Buffer.from(envelope.iv, "base64url")),
    );
    decipher.setAuthTag(
      Uint8Array.from(Buffer.from(envelope.authenticationTag, "base64url")),
    );
    const plaintext =
      decipher.update(envelope.ciphertext, "base64url", "utf8") +
      decipher.final("utf8");
    return validateDelivery(JSON.parse(plaintext) as unknown);
  } catch {
    throw new Error("OTP_DELIVERY_ENVELOPE_INVALID");
  }
}

function encryptionKey(secret: string): Uint8Array {
  if (secret.length < 32) throw new Error("OTP_DELIVERY_SECRET_INVALID");
  return Uint8Array.from(createHash("sha256").update(secret).digest());
}

function validateEnvelope(value: unknown): OtpDeliveryEnvelope {
  if (typeof value !== "object" || value === null) invalidEnvelope();
  const candidate = value as Record<string, unknown>;
  if (
    candidate["algorithm"] !== "A256GCM" ||
    !base64url(candidate["iv"], 16) ||
    !base64url(candidate["ciphertext"], 2_048) ||
    !base64url(candidate["authenticationTag"], 32)
  ) {
    invalidEnvelope();
  }
  return candidate as unknown as OtpDeliveryEnvelope;
}

function validateDelivery(value: unknown): OtpDelivery {
  if (typeof value !== "object" || value === null) invalidEnvelope();
  const candidate = value as Record<string, unknown>;
  const variables = candidate["variables"];
  if (
    typeof candidate["phoneE164"] !== "string" ||
    !/^\+[1-9][0-9]{7,14}$/.test(candidate["phoneE164"]) ||
    candidate["template"] !== "CUSTOMER_AUTHENTICATION_OTP" ||
    typeof variables !== "object" ||
    variables === null ||
    typeof (variables as Record<string, unknown>)["code"] !== "string" ||
    !/^[0-9]{4,9}$/.test(
      (variables as Record<string, unknown>)["code"] as string,
    )
  ) {
    invalidEnvelope();
  }
  return Object.freeze({
    phoneE164: candidate["phoneE164"] as string,
    template: "CUSTOMER_AUTHENTICATION_OTP" as const,
    variables: Object.freeze({
      code: (variables as Record<string, string>)["code"]!,
    }),
  });
}

function base64url(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function invalidEnvelope(): never {
  throw new Error("OTP_DELIVERY_ENVELOPE_INVALID");
}
