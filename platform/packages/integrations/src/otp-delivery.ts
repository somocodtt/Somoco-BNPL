import { createHash, createHmac } from "node:crypto";

const challengeIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface OtpDeliveryPolicyBinding {
  derivationKeyId: string;
  codeLength: number;
}

export function otpDerivationKeyId(secret: string): string {
  validateDerivationSecret(secret);
  return `otp-delivery-v1:${createHash("sha256")
    .update("somo:otp:delivery:key-id:v1\0")
    .update(secret)
    .digest("hex")
    .slice(0, 32)}`;
}

export function validateOtpDeliveryPolicy(input: {
  derivationSecret: string;
  derivationKeyId: string;
  codeLength: number;
}): Readonly<OtpDeliveryPolicyBinding> {
  const expectedKeyId = otpDerivationKeyId(input.derivationSecret);
  if (input.derivationKeyId !== expectedKeyId) {
    throw new Error("OTP_DERIVATION_KEY_ID_INVALID");
  }
  validateCodeLength(input.codeLength);
  return Object.freeze({
    derivationKeyId: input.derivationKeyId,
    codeLength: input.codeLength,
  });
}

export function deriveOtpCode(
  secret: string,
  challengeId: string,
  length: number,
): string {
  validateDerivationSecret(secret);
  if (!challengeIdPattern.test(challengeId)) {
    throw new Error("OTP_CHALLENGE_ID_INVALID");
  }
  validateCodeLength(length);
  const pseudorandom = createHmac("sha256", secret)
    .update("somo:otp:delivery:v1\0")
    .update(challengeId)
    .digest();
  const range = 10n ** BigInt(length);
  const value = pseudorandom.readBigUInt64BE(0) % range;
  return value.toString().padStart(length, "0");
}

function validateDerivationSecret(secret: string): void {
  if (secret.length < 32) throw new Error("OTP_DERIVATION_SECRET_INVALID");
}

function validateCodeLength(length: number): void {
  if (!Number.isInteger(length) || length < 4 || length > 9) {
    throw new Error("OTP_CODE_LENGTH_INVALID");
  }
}
