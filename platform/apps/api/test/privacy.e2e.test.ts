import { describe, expect, it } from "vitest";
import { createPrivacyService } from "../src/modules/privacy/service.js";

describe("privacy lifecycle", () => {
  it("exports only the requesting subject's safe data", async () => {
    const service = createPrivacyService({
      subjectData: async (subjectId) => ({
        personId: subjectId,
        profile: { displayName: "Applicant", phoneE164: "+233240000001" },
        otp: "never-export-this",
      }),
    });
    const request = await service.openRequest({
      subjectId: "00000000-0000-4000-8000-000000000001",
      subjectType: "APPLICANT",
      requestType: "ACCESS",
    });

    await expect(
      service.exportSubjectData({
        requestId: request.id,
        subjectId: request.subjectId,
      }),
    ).resolves.toEqual({
      subjectId: request.subjectId,
      profile: { displayName: "Applicant", phoneE164: "+233240000001" },
      restrictions: [],
      corrections: [],
    });
  });

  it("records corrections as append-only amendments and refuses immutable evidence", async () => {
    const service = createPrivacyService();
    const subjectId = "00000000-0000-4000-8000-000000000002";
    const access = await service.openRequest({
      subjectId,
      subjectType: "GUARANTOR",
      requestType: "ACCESS",
    });
    const correctionRequest = await service.openRequest({
      subjectId,
      subjectType: "GUARANTOR",
      requestType: "CORRECTION",
    });
    const actor = { id: "staff-compliance", role: "COMPLIANCE_OFFICER" };
    await expect(
      service.recordCorrection({
        requestId: correctionRequest.id,
        subjectId,
        field: "paymentBalance",
        proposedValue: "0",
        reason: "Not a profile correction",
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRIVACY_IMMUTABLE_EVIDENCE" });
    const first = await service.recordCorrection({
      requestId: correctionRequest.id,
      subjectId,
      field: "displayName",
      proposedValue: "Corrected name",
      reason: "Applicant supplied corrected spelling",
      actor,
    });
    const second = await service.recordCorrection({
      requestId: correctionRequest.id,
      subjectId,
      field: "displayName",
      proposedValue: "Second corrected name",
      reason: "Applicant supplied a newer correction",
      actor,
    });
    expect(first.version).toBe(1);
    expect(second.version).toBe(2);
    await expect(
      service.exportSubjectData({ requestId: access.id, subjectId }),
    ).resolves.toMatchObject({
      corrections: [
        { field: "displayName", version: 1 },
        { field: "displayName", version: 2 },
      ],
    });
  });

  it("requires an approved retention policy and skips legal holds", async () => {
    const subjectId = "00000000-0000-4000-8000-000000000003";
    const heldSubjectId = "00000000-0000-4000-8000-000000000004";
    const service = createPrivacyService({
      subjectIds: [subjectId, heldSubjectId],
      now: () => new Date("2026-08-23T00:00:00.000Z"),
    });
    const actor = { id: "staff-compliance", role: "DPO" };
    await expect(
      service.applyRetention({
        policyVersion: "retention-v1",
        actor,
      }),
    ).rejects.toMatchObject({ code: "PRIVACY_RETENTION_POLICY_NOT_APPROVED" });
    const correctionRequest = await service.openRequest({
      subjectId,
      subjectType: "APPLICANT",
      requestType: "CORRECTION",
    });
    await service.recordCorrection({
      requestId: correctionRequest.id,
      subjectId,
      field: "displayName",
      proposedValue: "Old name",
      reason: "Historical correction",
      actor,
    });
    await service.placeLegalHold({
      subjectId: heldSubjectId,
      reason: "Regulatory review",
      actor,
    });
    await service.approveRetentionPolicy({
      version: "retention-v1",
      retentionDays: 30,
      actor,
    });
    await expect(
      service.applyRetention({
        policyVersion: "retention-v1",
        asOf: new Date("2027-01-01T00:00:00.000Z"),
        actor,
      }),
    ).resolves.toEqual({
      policyVersion: "retention-v1",
      evaluated: 2,
      anonymized: 1,
      retained: 0,
      skippedLegalHold: 1,
      immutableEvidenceRetained: 2,
    });
  });
});
