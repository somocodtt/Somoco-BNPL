export interface NiaPort {
  verify(input: {
    correlationId: string;
    ghanaCardNumber: string;
    consentId: string;
  }): Promise<{
    providerReference: string;
    decision: "MATCH" | "NO_MATCH" | "REVIEW";
    checkedAt: string;
  }>;
}
