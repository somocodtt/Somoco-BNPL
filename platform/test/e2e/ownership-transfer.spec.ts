import {
  expect,
  test,
} from "../../apps/customer-web/node_modules/@playwright/test/index.mjs";
import { contractId, startPilotHarness } from "./support/pilot-harness.js";
import {
  api,
  assertStatus,
  body,
  call,
  postPayment,
} from "./support/pilot-client.js";

test("ownership stays with Somoco until balance, reconciliation, evidence, and dual approvals are clean", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    harness.seedActiveContract("30000");
    const client = api(request);
    const blocked = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/ownership-transfer`,
      { token: harness.staffTokens.MD },
    );
    assertStatus(blocked, 409);
    expect((await body(blocked)).code).toBe("OWNERSHIP_TRANSFER_NOT_ALLOWED");
    expect(harness.state.contract?.ownershipHolder).toBe("SOMOCO");

    const financeBlocked = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/finance-approval`,
      {
        token: harness.staffTokens.FINANCE_OFFICER,
        body: {
          reason: "Attempt before final repayment",
          idempotencyKey: "finance-blocked-001",
        },
      },
    );
    assertStatus(financeBlocked, 409);

    const repayment = await postPayment(client, harness, {
      eventId: "ownership-repayment-001",
      eventType: "PAYMENT_SUCCEEDED",
      providerTransactionId: "ownership-repayment-tx-001",
      payerPhoneE164: "+233241000001",
      customerReference: contractId,
      channel: "MOBILE_MONEY",
      amount: { currency: "GHS", minorUnits: "30000" },
      occurredAt: "2026-08-23T12:00:00.000Z",
    });
    assertStatus(repayment, 202);
    expect(harness.state.contract?.outstandingBalanceMinor).toBe("0");

    const wrongBusinessRole = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/business-approval`,
      {
        token: harness.staffTokens.CFO,
        body: {
          reason: "Wrong maker",
          idempotencyKey: "business-wrong-role-001",
        },
      },
    );
    assertStatus(wrongBusinessRole, 403);
    const finance = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/finance-approval`,
      {
        token: harness.staffTokens.FINANCE_OFFICER,
        body: {
          reason: "Final ledger reconciliation clean",
          idempotencyKey: "finance-clean-001",
        },
      },
    );
    assertStatus(finance, 200);
    const business = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/business-approval`,
      {
        token: harness.staffTokens.MD,
        body: {
          reason: "Final ownership review",
          idempotencyKey: "business-clean-001",
        },
      },
    );
    assertStatus(business, 200);
    const evidence = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/evidence`,
      {
        token: harness.staffTokens.INVENTORY_OFFICER,
        body: { evidenceDocumentId: "95000000-0000-4000-8000-000000000002" },
      },
    );
    assertStatus(evidence, 200);
    const committed = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/commit`,
      { token: harness.staffTokens.CFO },
    );
    assertStatus(committed, 200);
    expect((await body(committed)).ownershipHolder).toBe("SOMOCO");
    const transferred = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/ownership-transfer`,
      { token: harness.staffTokens.MD },
    );
    assertStatus(transferred, 200);
    expect((await body(transferred)).ownershipHolder).toBe("CUSTOMER");
  } finally {
    await harness.close();
  }
});
