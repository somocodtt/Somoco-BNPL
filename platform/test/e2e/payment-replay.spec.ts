import {
  expect,
  test,
} from "../../apps/customer-web/node_modules/@playwright/test/index.mjs";
import { applicationId, startPilotHarness } from "./support/pilot-harness.js";
import {
  api,
  assertStatus,
  body,
  call,
  completeOnboarding,
  createAndAcceptOffer,
  approveAllStages,
  postPayment,
} from "./support/pilot-client.js";

test("payment replay is ledger- and receipt-idempotent while unmatched events remain reconciliation cases", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    const client = api(request);
    await completeOnboarding(client, harness);
    await approveAllStages(client, harness);
    await createAndAcceptOffer(client, harness);
    const event = {
      eventId: "replay-deposit-001",
      eventType: "PAYMENT_SUCCEEDED",
      providerTransactionId: "replay-transaction-001",
      payerPhoneE164: "+233241000001",
      customerReference: applicationId,
      channel: "MOBILE_MONEY",
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-23T12:00:00.000Z",
    };
    const first = await postPayment(client, harness, event);
    assertStatus(first, 202);
    const firstBody = await body(first);
    const replay = await postPayment(client, harness, event);
    assertStatus(replay, 202);
    expect(await body(replay)).toMatchObject({
      replay: true,
      ledgerEntryId: firstBody.ledgerEntryId,
      receiptId: firstBody.receiptId,
    });
    expect(harness.state.ledger).toHaveLength(1);
    expect(Object.keys(harness.state.receipts)).toHaveLength(1);

    const unmatchedEvent = {
      ...event,
      eventId: "unmatched-payment-001",
      providerTransactionId: "unmatched-transaction-001",
      customerReference: "UNKNOWN-CUSTOMER-REFERENCE",
    };
    const unmatched = await postPayment(client, harness, unmatchedEvent);
    assertStatus(unmatched, 202);
    expect(await body(unmatched)).toMatchObject({
      status: "UNMATCHED",
      replay: false,
    });
    const unmatchedReplay = await postPayment(client, harness, unmatchedEvent);
    assertStatus(unmatchedReplay, 202);
    expect(await body(unmatchedReplay)).toMatchObject({
      status: "UNMATCHED",
      replay: true,
    });
    expect(harness.state.ledger).toHaveLength(1);
    expect(harness.state.reconciliation).toHaveLength(1);

    const cash = await postPayment(client, harness, {
      ...event,
      eventId: "cash-payment-001",
      providerTransactionId: "cash-transaction-001",
      channel: "CASH",
    });
    assertStatus(cash, 422);
    expect((await body(cash)).code).toBe("CASH_NOT_ACCEPTED");
  } finally {
    await harness.close();
  }
});

test("SAP outage boundary remains fail-closed and synchronization stays disabled", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    const response = await call(
      api(request),
      harness.baseUrl,
      "post",
      "/v1/integrations/sap/sync",
      { body: { eventId: "sap-001" } },
    );
    assertStatus(response, 503);
    expect((await body(response)).code).toBe("SAP_SYNC_DISABLED");
    expect(harness.state.provider.sapSyncEnabled).toBe(false);
  } finally {
    await harness.close();
  }
});
