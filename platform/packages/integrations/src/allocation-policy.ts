export interface AllocationPolicyEvidenceVerificationInput {
  readonly signedBytes: Uint8Array;
  readonly evidence: {
    readonly artifactHash: string;
    readonly financeApprovedBy: string;
    readonly complianceApprovedBy: string;
    readonly financeSignature: string;
    readonly complianceSignature: string;
    readonly financeApprovedAt: string;
    readonly complianceApprovedAt: string;
    readonly policyVersion: string;
    readonly executionKey: string;
    readonly allocationEngineDigest: string;
  };
}

export interface AllocationPolicyEvidenceVerification {
  readonly attestationReference: string;
}

/**
 * Provider-neutral boundary for trusted Finance/Compliance signature and key
 * verification. Key custody, signature format, and trust roots remain
 * external to the application.
 */
export interface AllocationPolicyEvidenceVerifier {
  verify(
    input: AllocationPolicyEvidenceVerificationInput,
  ): Promise<AllocationPolicyEvidenceVerification>;
}
