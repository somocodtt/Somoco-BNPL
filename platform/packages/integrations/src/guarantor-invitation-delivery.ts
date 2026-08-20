import { createHash, createHmac } from "node:crypto";

const invitationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const GUARANTOR_INVITATION_TOKEN_VERSION = 1;

export interface GuarantorInvitationDeliveryPolicyBinding {
  derivationKeyId: string;
  tokenVersion: number;
}

export function guarantorInvitationDerivationKeyId(
  secret: string,
  tokenVersion = GUARANTOR_INVITATION_TOKEN_VERSION,
): string {
  validateSecret(secret);
  validateTokenVersion(tokenVersion);
  return `guarantor-invitation-v${tokenVersion}:${createHash("sha256")
    .update(`somo:guarantor:invitation:key-id:v${tokenVersion}\0`)
    .update(secret)
    .digest("hex")
    .slice(0, 32)}`;
}

export function validateGuarantorInvitationDeliveryPolicy(input: {
  derivationSecret: string;
  derivationKeyId: string;
  tokenVersion: number;
}): Readonly<GuarantorInvitationDeliveryPolicyBinding> {
  const expectedKeyId = guarantorInvitationDerivationKeyId(
    input.derivationSecret,
    input.tokenVersion,
  );
  if (input.derivationKeyId !== expectedKeyId) {
    throw new Error("GUARANTOR_INVITATION_DERIVATION_KEY_ID_INVALID");
  }
  return Object.freeze({
    derivationKeyId: input.derivationKeyId,
    tokenVersion: input.tokenVersion,
  });
}

export function deriveGuarantorInvitationToken(
  secret: string,
  invitationId: string,
  tokenVersion = GUARANTOR_INVITATION_TOKEN_VERSION,
): string {
  validateSecret(secret);
  validateTokenVersion(tokenVersion);
  if (!invitationIdPattern.test(invitationId)) {
    throw new Error("GUARANTOR_INVITATION_ID_INVALID");
  }
  return createHmac("sha256", secret)
    .update(`somo:guarantor:invitation:v${tokenVersion}\0${invitationId}`)
    .digest("base64url");
}

function validateSecret(secret: string): void {
  if (secret.length < 32) {
    throw new Error("GUARANTOR_INVITATION_DERIVATION_SECRET_INVALID");
  }
}

function validateTokenVersion(tokenVersion: number): void {
  if (tokenVersion !== GUARANTOR_INVITATION_TOKEN_VERSION) {
    throw new Error("GUARANTOR_INVITATION_TOKEN_VERSION_INVALID");
  }
}
