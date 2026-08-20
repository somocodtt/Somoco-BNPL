import type { ApplicantMutation } from "./api.js";

const storageKey = "somo-safe-mutations-v1";

export interface QueuedApplicantMutation {
  applicationId: string;
  input: ApplicantMutation;
}

export class SafeMutationQueue {
  constructor(
    private readonly storage: Pick<
      Storage,
      "getItem" | "setItem" | "removeItem"
    >,
  ) {}

  enqueue(applicationId: string, input: ApplicantMutation): void {
    const safe: QueuedApplicantMutation = {
      applicationId,
      input: {
        expectedVersion: input.expectedVersion,
        mutationId: input.mutationId,
        vehicleModelId: input.vehicleModelId,
        profile: {
          occupation: input.profile.occupation,
          residentialArea: input.profile.residentialArea,
        },
      },
    };
    this.storage.setItem(storageKey, JSON.stringify([safe]));
  }

  read(): QueuedApplicantMutation[] {
    const value = this.storage.getItem(storageKey);
    if (value === null) return [];
    try {
      return JSON.parse(value) as QueuedApplicantMutation[];
    } catch {
      this.storage.removeItem(storageKey);
      return [];
    }
  }

  clear(): void {
    this.storage.removeItem(storageKey);
  }
}
