import { createHmac } from "node:crypto";

const challengeIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function deriveOtpCode(
  secret: string,
  challengeId: string,
  length: number,
): string {
  if (secret.length < 32) throw new Error("OTP_DERIVATION_SECRET_INVALID");
  if (!challengeIdPattern.test(challengeId)) {
    throw new Error("OTP_CHALLENGE_ID_INVALID");
  }
  if (!Number.isInteger(length) || length < 4 || length > 9) {
    throw new Error("OTP_CODE_LENGTH_INVALID");
  }
  const pseudorandom = createHmac("sha256", secret)
    .update("somo:otp:delivery:v1\0")
    .update(challengeId)
    .digest();
  const range = 10n ** BigInt(length);
  const value = pseudorandom.readBigUInt64BE(0) % range;
  return value.toString().padStart(length, "0");
}
