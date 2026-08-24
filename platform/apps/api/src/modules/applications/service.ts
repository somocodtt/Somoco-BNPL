import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  createApplicationDraft,
  createGuarantorInvitation,
  listActiveVehicleModels,
  readOwnedApplicationState,
  readResumableApplication,
  recordApplicationSignature,
  resolveGuarantorInvitation,
  saveApplicantSection,
  saveGuarantorSection,
  submitApplication,
  type ApplicationActor,
  type Database,
} from "@somo/db";
import {
  deriveGuarantorInvitationToken,
  GUARANTOR_INVITATION_TOKEN_VERSION,
  guarantorInvitationDerivationKeyId,
} from "@somo/integrations";
import { AppError } from "../../plugins/errors.js";
import {
  assertApplicationComplete,
  getApplicationCompleteness,
} from "./completeness.js";

export type ApplicationContext = ApplicationActor;

export interface ApplicationService {
  listVehicleModels(): Promise<
    Array<{
      id: string;
      manufacturer: string;
      modelName: string;
      modelYear: number;
    }>
  >;
  createDraft(context: ApplicationContext): Promise<ApplicationCommandResult>;
  resume(context: ApplicationContext): Promise<{
    draft:
      | (ApplicationCommandResult & {
          vehicleModelId: string | null;
          applicantProfile: Record<string, unknown>;
        })
      | null;
    guarantorStatus: "NOT_INVITED" | "INVITED" | "EXPIRED" | "CONFIRMED";
    guarantorInvitation: {
      status: "NOT_INVITED" | "INVITED" | "EXPIRED" | "CONFIRMED";
      relationshipVersion: number | null;
      expiresAt: string | null;
    };
  }>;
  saveApplicant(
    applicationId: string,
    context: ApplicationContext,
    input: ApplicantSaveInput,
  ): Promise<ApplicationCommandResult>;
  inviteGuarantor(
    applicationId: string,
    context: ApplicationContext,
    input: GuarantorInviteInput,
  ): Promise<{
    invitationId: string;
    expiresAt: string;
    applicationVersion: number;
    relationshipVersion: number;
  }>;
  saveGuarantor(
    invitationToken: string,
    context: ApplicationContext,
    input: GuarantorSaveInput,
  ): Promise<{
    relationshipVersion: number;
    applicationVersion: number;
    status: string;
  }>;
  resolveGuarantorInvitation(
    invitationToken: string,
    context: ApplicationContext,
  ): Promise<{
    status: string;
    relationshipVersion: number;
    applicationVersion: number;
    expiresAt: string;
  }>;
  getCompleteness(
    applicationId: string,
    context: ApplicationContext,
  ): Promise<ReturnType<typeof getApplicationCompleteness>>;
  submit(
    applicationId: string,
    context: ApplicationContext,
    input: MutationVersionInput,
  ): Promise<ApplicationCommandResult>;
  recordSignature(
    applicationId: string,
    context: ApplicationContext,
    input: SignatureInput,
  ): Promise<{
    id: string;
    applicationId: string;
    personId: string;
    purpose: "CONTRACT_EXECUTION";
    signatureHash: string;
    signedAt: string;
    replay: boolean;
  }>;
}

export interface MutationVersionInput {
  expectedVersion: number;
  mutationId: string;
}

export interface ApplicantSaveInput extends MutationVersionInput {
  productId?: string;
  vehicleModelId: string;
  profile: Record<string, unknown>;
}

export interface GuarantorInviteInput extends MutationVersionInput {
  guarantorPhoneE164: string;
}

export interface GuarantorSaveInput extends MutationVersionInput {
  profile: Record<string, unknown>;
}

export interface SignatureInput {
  idempotencyKey: string;
  signature: string;
}

interface ApplicationCommandResult {
  id: string;
  status: string;
  version: number;
}

export function createApplicationService(options: {
  database: Database;
  invitationHashSecret: string;
  invitationTtlMs: number;
  requiredDocumentTypes: readonly string[];
  clock?: { now(): Date };
}): ApplicationService {
  const policy = validatePolicy(options);
  const clock = options.clock ?? { now: () => new Date() };

  return {
    async listVehicleModels() {
      return listActiveVehicleModels(options.database);
    },

    async createDraft(context) {
      return mapErrors(() =>
        createApplicationDraft(options.database, context, clock.now()),
      );
    },

    async resume(context) {
      return readResumableApplication(
        options.database,
        context.personId,
        clock.now(),
      );
    },

    async saveApplicant(applicationId, context, input) {
      assertMutation(input);
      if (input.productId !== undefined)
        assertUuid(input.productId, "PRODUCT_ID_INVALID");
      assertUuid(input.vehicleModelId, "VEHICLE_MODEL_INVALID");
      assertProfile(input.profile);
      const command = mutationCommand(
        applicationId,
        context,
        input,
        "SAVE_APPLICANT",
        {
          ...(input.productId === undefined
            ? {}
            : { productId: input.productId }),
          vehicleModelId: input.vehicleModelId,
          profile: input.profile,
        },
      );
      return mapErrors(() =>
        saveApplicantSection(options.database, {
          ...command,
          expectedVersion: input.expectedVersion,
          ...(input.productId === undefined
            ? {}
            : { productId: input.productId }),
          vehicleModelId: input.vehicleModelId,
          profile: input.profile,
          now: clock.now(),
        }),
      );
    },

    async inviteGuarantor(applicationId, context, input) {
      assertMutation(input);
      if (!/^\+233[1-9]\d{8}$/.test(input.guarantorPhoneE164)) {
        throw new AppError(
          400,
          "PHONE_INVALID",
          "Enter a valid Ghana phone number.",
        );
      }
      const invitationId = randomUUID();
      const token = deriveGuarantorInvitationToken(
        policy.invitationHashSecret,
        invitationId,
        GUARANTOR_INVITATION_TOKEN_VERSION,
      );
      const derivationKeyId = guarantorInvitationDerivationKeyId(
        policy.invitationHashSecret,
        GUARANTOR_INVITATION_TOKEN_VERSION,
      );
      const now = clock.now();
      const command = mutationCommand(
        applicationId,
        context,
        input,
        "INVITE_GUARANTOR",
        {
          guarantorPhoneE164: input.guarantorPhoneE164,
        },
      );
      const result = await mapErrors(() =>
        createGuarantorInvitation(options.database, {
          ...command,
          expectedVersion: input.expectedVersion,
          invitationId,
          guarantorPhoneE164: input.guarantorPhoneE164,
          tokenHash: hashToken(policy.invitationHashSecret, token),
          tokenVersion: GUARANTOR_INVITATION_TOKEN_VERSION,
          derivationKeyId,
          expiresAt: new Date(now.getTime() + policy.invitationTtlMs),
          now,
        }),
      );
      return result;
    },

    async saveGuarantor(invitationTokenValue, context, input) {
      assertMutation(input);
      assertProfile(input.profile);
      if (!/^[A-Za-z0-9_-]{43}$/.test(invitationTokenValue)) {
        throw new AppError(
          404,
          "INVITATION_NOT_FOUND",
          "Invitation was not found.",
        );
      }
      return mapErrors(() =>
        saveGuarantorSection(options.database, {
          actor: context,
          mutationId: input.mutationId,
          operation: "SAVE_GUARANTOR",
          payloadHash: payloadHash({
            expectedVersion: input.expectedVersion,
            profile: input.profile,
          }),
          tokenHash: hashToken(
            policy.invitationHashSecret,
            invitationTokenValue,
          ),
          expectedVersion: input.expectedVersion,
          profile: input.profile,
          now: clock.now(),
        }),
      );
    },

    async resolveGuarantorInvitation(invitationTokenValue, context) {
      assertInvitationToken(invitationTokenValue);
      return mapErrors(() =>
        resolveGuarantorInvitation(options.database, {
          tokenHash: hashToken(
            policy.invitationHashSecret,
            invitationTokenValue,
          ),
          guarantorPersonId: context.personId,
          now: clock.now(),
        }),
      );
    },

    async getCompleteness(applicationId, context) {
      const state = await mapErrors(() =>
        readOwnedApplicationState(
          options.database,
          applicationId,
          context.personId,
        ),
      );
      return getApplicationCompleteness(state, policy.requiredDocumentTypes);
    },

    async submit(applicationId, context, input) {
      assertMutation(input);
      const command = mutationCommand(
        applicationId,
        context,
        input,
        "SUBMIT_APPLICATION",
        {},
      );
      return mapErrors(() =>
        submitApplication(
          options.database,
          {
            ...command,
            expectedVersion: input.expectedVersion,
            now: clock.now(),
          },
          (state) =>
            assertApplicationComplete(state, policy.requiredDocumentTypes),
        ),
      );
    },

    async recordSignature(applicationId, context, input) {
      assertUuid(applicationId, "APPLICATION_ID_INVALID");
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(input.idempotencyKey))
        throw new AppError(
          400,
          "SIGNATURE_IDEMPOTENCY_INVALID",
          "A valid signature retry key is required.",
        );
      const signature = input.signature.trim();
      if (signature.length < 8 || signature.length > 4096)
        throw new AppError(
          400,
          "SIGNATURE_INVALID",
          "A non-empty signature is required.",
        );
      return mapErrors(() =>
        recordApplicationSignature(options.database, {
          applicationId,
          actor: context,
          idempotencyKey: input.idempotencyKey,
          signature,
          now: clock.now(),
        }),
      );
    },
  };
}

function mutationCommand(
  applicationId: string,
  actor: ApplicationContext,
  input: MutationVersionInput,
  operation: string,
  payload: Record<string, unknown>,
) {
  assertUuid(applicationId, "APPLICATION_ID_INVALID");
  return {
    actor,
    applicationId,
    mutationId: input.mutationId,
    operation,
    payloadHash: payloadHash({
      expectedVersion: input.expectedVersion,
      ...payload,
    }),
  };
}

function validatePolicy(options: {
  invitationHashSecret: string;
  invitationTtlMs: number;
  requiredDocumentTypes: readonly string[];
}) {
  if (options.invitationHashSecret.length < 32)
    throw new Error("INVITATION_SECRET_INVALID");
  if (
    !Number.isSafeInteger(options.invitationTtlMs) ||
    options.invitationTtlMs < 1
  ) {
    throw new Error("INVITATION_TTL_INVALID");
  }
  if (
    options.requiredDocumentTypes.length === 0 ||
    options.requiredDocumentTypes.some(
      (value) => !/^[A-Z][A-Z0-9_]{1,63}$/.test(value),
    )
  ) {
    throw new Error("DOCUMENT_REQUIREMENTS_INVALID");
  }
  return Object.freeze({
    invitationHashSecret: options.invitationHashSecret,
    invitationTtlMs: options.invitationTtlMs,
    requiredDocumentTypes: Object.freeze([
      ...new Set(options.requiredDocumentTypes),
    ]),
  });
}

function assertMutation(input: MutationVersionInput): void {
  assertUuid(input.mutationId, "MUTATION_ID_INVALID");
  if (
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion < 1
  ) {
    throw new AppError(400, "VERSION_INVALID", "The saved version is invalid.");
  }
}

function assertProfile(profile: Record<string, unknown>): void {
  if (Object.keys(profile).length === 0) {
    throw new AppError(
      400,
      "PROFILE_INVALID",
      "Complete the required details.",
    );
  }
  const forbidden = /ghana.?card|otp|document|password|secret/i;
  if (Object.keys(profile).some((key) => forbidden.test(key))) {
    throw new AppError(
      400,
      "PROFILE_SENSITIVE_FIELD",
      "Sensitive identity data is not accepted here.",
    );
  }
}

function assertInvitationToken(value: string): void {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AppError(
      404,
      "INVITATION_NOT_FOUND",
      "Invitation was not found.",
    );
  }
}

function assertUuid(value: string, code: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new AppError(400, code, "The request identifier is invalid.");
  }
}

function hashToken(secret: string, token: string): string {
  return createHmac("sha256", secret)
    .update(`stored-invitation\0${token}`)
    .digest("hex");
}

function payloadHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function mapErrors<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof AppError) throw error;
    const code = error instanceof Error ? error.message : "UNKNOWN";
    const mapping: Record<string, [number, string]> = {
      APPLICATION_NOT_FOUND: [404, "Application was not found."],
      INVITATION_NOT_FOUND: [404, "Invitation was not found."],
      INVITATION_EXPIRED: [409, "This guarantor invitation has expired."],
      INVITATION_ALREADY_CLAIMED: [
        409,
        "This guarantor invitation has already been used.",
      ],
      VERSION_CONFLICT: [
        409,
        "This draft changed on another device. Refresh before saving again.",
      ],
      IDEMPOTENCY_CONFLICT: [
        409,
        "This offline retry key was already used for another change.",
      ],
      VEHICLE_MODEL_UNAVAILABLE: [
        409,
        "The selected vehicle model is no longer available.",
      ],
      PRODUCT_UNAVAILABLE: [
        409,
        "The selected financing product is no longer available for this model.",
      ],
      SIGNATURE_NOT_AUTHORIZED: [
        403,
        "Only the applicant or confirmed guarantor can sign this application.",
      ],
      OFFER_NOT_ACCEPTED: [
        409,
        "The offer must be accepted before contract signatures are recorded.",
      ],
      SIGNATURE_ALREADY_RECORDED: [
        409,
        "A contract signature is already recorded for this person.",
      ],
      GUARANTOR_MUST_BE_INDEPENDENT: [
        400,
        "The applicant cannot act as their own guarantor.",
      ],
      APPLICATION_STATE_INVALID: [
        409,
        "The application cannot be changed in its current state.",
      ],
    };
    const mapped = mapping[code];
    if (mapped === undefined) throw error;
    throw new AppError(mapped[0], code, mapped[1]);
  }
}
