import type { ApplicationState } from "@somo/db";
import { AppError } from "../../plugins/errors.js";

export type CompletenessCode =
  | "VEHICLE_MODEL_REQUIRED"
  | "APPLICANT_DETAILS_INCOMPLETE"
  | "APPLICANT_IDENTITY_INCOMPLETE"
  | "APPLICANT_DOCUMENTS_INCOMPLETE"
  | "GUARANTOR_INCOMPLETE"
  | "GUARANTOR_IDENTITY_INCOMPLETE"
  | "GUARANTOR_DOCUMENTS_INCOMPLETE";

export interface ApplicationCompleteness {
  ready: boolean;
  missing: CompletenessCode[];
  documentProgress: {
    applicant: { accepted: string[]; required: string[] };
    guarantor: { accepted: string[]; required: string[] };
  };
}

export function getApplicationCompleteness(
  state: ApplicationState,
  requiredDocumentTypes: readonly string[],
): ApplicationCompleteness {
  const missing: CompletenessCode[] = [];
  if (state.vehicleModelId === null || !state.vehicleModelActive) {
    missing.push("VEHICLE_MODEL_REQUIRED");
  }
  if (!hasProfile(state.applicantProfile)) {
    missing.push("APPLICANT_DETAILS_INCOMPLETE");
  }
  if (state.applicantIdentity === null) {
    missing.push("APPLICANT_IDENTITY_INCOMPLETE");
  }
  const applicantAccepted = acceptedTypes(state.applicantDocuments);
  if (!containsAll(applicantAccepted, requiredDocumentTypes)) {
    missing.push("APPLICANT_DOCUMENTS_INCOMPLETE");
  }
  if (
    state.guarantorPersonId === null ||
    state.guarantorStatus !== "CONFIRMED" ||
    !hasProfile(state.guarantorProfile)
  ) {
    missing.push("GUARANTOR_INCOMPLETE");
  } else {
    if (state.guarantorIdentity === null) {
      missing.push("GUARANTOR_IDENTITY_INCOMPLETE");
    }
    const guarantorAccepted = acceptedTypes(state.guarantorDocuments);
    if (!containsAll(guarantorAccepted, requiredDocumentTypes)) {
      missing.push("GUARANTOR_DOCUMENTS_INCOMPLETE");
    }
  }
  return {
    ready: missing.length === 0,
    missing,
    documentProgress: {
      applicant: {
        accepted: applicantAccepted,
        required: [...requiredDocumentTypes],
      },
      guarantor: {
        accepted: acceptedTypes(state.guarantorDocuments),
        required: [...requiredDocumentTypes],
      },
    },
  };
}

export function assertApplicationComplete(
  state: ApplicationState,
  requiredDocumentTypes: readonly string[],
): void {
  const code = getApplicationCompleteness(state, requiredDocumentTypes)
    .missing[0];
  if (code !== undefined) {
    throw new AppError(409, code, publicDetail(code));
  }
}

function hasProfile(profile: Record<string, unknown> | null): boolean {
  return profile !== null && Object.keys(profile).length > 0;
}

function acceptedTypes(
  documents: ApplicationState["applicantDocuments"],
): string[] {
  return [
    ...new Set(documents.map((document) => document.documentType)),
  ].sort();
}

function containsAll(actual: string[], required: readonly string[]): boolean {
  return required.every((documentType) => actual.includes(documentType));
}

function publicDetail(code: CompletenessCode): string {
  const details: Record<CompletenessCode, string> = {
    VEHICLE_MODEL_REQUIRED:
      "Select an available vehicle model before submitting.",
    APPLICANT_DETAILS_INCOMPLETE:
      "Complete the applicant details before submitting.",
    APPLICANT_IDENTITY_INCOMPLETE:
      "Complete applicant identity verification before submitting.",
    APPLICANT_DOCUMENTS_INCOMPLETE:
      "Upload all required applicant evidence before submitting.",
    GUARANTOR_INCOMPLETE:
      "The guarantor must complete their section independently.",
    GUARANTOR_IDENTITY_INCOMPLETE:
      "The guarantor must complete their own identity verification.",
    GUARANTOR_DOCUMENTS_INCOMPLETE:
      "The guarantor must upload all required clean evidence.",
  };
  return details[code];
}
