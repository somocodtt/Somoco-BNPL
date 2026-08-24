import { describe, expect, it } from "vitest";
import {
  createExceptionService,
  type ExceptionRequestInput,
} from "./exception-service.js";

const actor = {
  kind: "staff" as const,
  staffUserId: "00000000-0000-0000-0000-000000000001",
  roles: ["PRODUCT_ADMIN" as const],
  sessionId: "00000000-0000-0000-0000-000000000002",
};

const base = {
  applicationId: "00000000-0000-0000-0000-000000000003",
  proposedValue: { minimumDepositMinor: "10000" },
  policyValue: { minimumDepositMinor: "30000" },
  ruleVersionId: "00000000-0000-0000-0000-000000000004",
  exceptionField: "minimumDepositMinor" as const,
  valueType: "AMOUNT" as const,
  proposedAmountMinor: "10000",
  policyAmountMinor: "30000",
  reason: "Synthetic validation test",
  requiredApproverRole: "PRODUCT_ADMIN" as const,
  idempotencyKey: "00000000-0000-0000-0000-000000000005",
  actor,
  requestId: "00000000-0000-0000-0000-000000000006",
};

describe("exception binding validation", () => {
  it("rejects a read-only auditor as a product exception authority", async () => {
    const service = createExceptionService({ database: undefined as never });
    await expect(
      service.request({
        ...base,
        requiredApproverRole: "COMPLIANCE_AUDITOR",
      }),
    ).rejects.toMatchObject({ code: "APPROVER_ROLE_INVALID" });
  });

  it("rejects irrelevant typed fields in a discriminated amount exception", async () => {
    const service = createExceptionService({ database: undefined as never });
    await expect(
      service.request({
        ...base,
        proposedFrequency: "MONTHLY",
      } as unknown as ExceptionRequestInput),
    ).rejects.toMatchObject({ code: "EXCEPTION_BINDING_INVALID" });
  });

  it("rejects proposed or policy values that do not match normalized typed values", async () => {
    const service = createExceptionService({ database: undefined as never });
    await expect(
      service.request({
        ...base,
        proposedValue: { minimumDepositMinor: "9999" },
      }),
    ).rejects.toMatchObject({ code: "EXCEPTION_BINDING_INVALID" });
  });
});
