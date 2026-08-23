import {
  expect,
  test,
} from "../../apps/customer-web/node_modules/@playwright/test/index.mjs";
import { contractId, startPilotHarness } from "./support/pilot-harness.js";
import { api, assertStatus, body, call, json } from "./support/pilot-client.js";

test("consecutive and total-unpaid arrears signals remain separate and do not open recovery automatically", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    const client = api(request);
    harness.setArrears({ consecutiveMissed: 3, totalUnpaid: 0 });
    const consecutive = await call(
      client,
      harness.baseUrl,
      "get",
      "/v1/staff/collections/arrears",
      { token: harness.staffTokens.RECOVERY_OFFICER },
    );
    assertStatus(consecutive, 200);
    expect(await json(consecutive)).toEqual([
      {
        contractId,
        consecutiveMissedInstallments: 3,
        unpaidInstallments: 0,
        signals: ["THREE_CONSECUTIVE_MISSED"],
      },
    ]);
    harness.setArrears({ consecutiveMissed: 0, totalUnpaid: 3 });
    const total = await call(
      client,
      harness.baseUrl,
      "get",
      "/v1/staff/collections/arrears",
      { token: harness.staffTokens.RECOVERY_OFFICER },
    );
    assertStatus(total, 200);
    expect(await json(total)).toEqual([
      {
        contractId,
        consecutiveMissedInstallments: 0,
        unpaidInstallments: 3,
        signals: ["THREE_TOTAL_UNPAID"],
      },
    ]);
    harness.setArrears({ consecutiveMissed: 3, totalUnpaid: 3 });
    const both = await call(
      client,
      harness.baseUrl,
      "get",
      "/v1/staff/collections/arrears",
      { token: harness.staffTokens.RECOVERY_OFFICER },
    );
    assertStatus(both, 200);
    expect(await json(both)).toEqual([
      {
        contractId,
        consecutiveMissedInstallments: 3,
        unpaidInstallments: 3,
        signals: ["THREE_CONSECUTIVE_MISSED", "THREE_TOTAL_UNPAID"],
      },
    ]);
    const cases = await call(
      client,
      harness.baseUrl,
      "get",
      "/v1/staff/collections/cases",
      { token: harness.staffTokens.RECOVERY_OFFICER },
    );
    assertStatus(cases, 200);
    expect(await cases.json()).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("tracker access is role- and recovery-case-gated, and automatic immobilization is unavailable", async ({
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    const client = api(request);
    const unauthorized = await call(
      client,
      harness.baseUrl,
      "get",
      "/v1/staff/assets/90000000-0000-4000-8000-000000000001/tracker",
      { token: harness.staffTokens.CUSTOMER_SUPPORT },
    );
    assertStatus(unauthorized, 403);
    const withoutCase = await call(
      client,
      harness.baseUrl,
      "get",
      "/v1/staff/assets/90000000-0000-4000-8000-000000000001/tracker",
      { token: harness.staffTokens.RECOVERY_OFFICER },
    );
    assertStatus(withoutCase, 409);
    expect((await body(withoutCase)).code).toBe(
      "RECOVERY_AUTHORIZATION_REQUIRED",
    );

    const opened = await call(
      client,
      harness.baseUrl,
      "post",
      "/v1/staff/collections/cases",
      {
        token: harness.staffTokens.RECOVERY_OFFICER,
        body: {
          contractId,
          purpose: "Human recovery review",
          reason: "Synthetic arrears signal",
        },
      },
    );
    assertStatus(opened, 201);
    const openedBody = await body(opened);
    const approved = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/collections/cases/${String(openedBody.id)}/decision`,
      {
        token: harness.staffTokens.RECOVERY_OFFICER,
        body: {
          decision: "APPROVED",
          purpose: "Human recovery review",
          reason: "Approved after review",
          idempotencyKey: "recovery-decision-001",
        },
      },
    );
    assertStatus(approved, 200);
    const location = await call(
      client,
      harness.baseUrl,
      "get",
      "/v1/staff/assets/90000000-0000-4000-8000-000000000001/tracker?purpose=AUTHORIZED_RECOVERY_REVIEW",
      { token: harness.staffTokens.RECOVERY_OFFICER },
    );
    assertStatus(location, 200);
    expect(await body(location)).toMatchObject({ locationOnly: true });

    const automatic = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/collections/cases/${String(openedBody.id)}/actions`,
      {
        token: harness.staffTokens.RECOVERY_OFFICER,
        body: {
          actionType: "AUTO_IMMOBILIZE",
          purpose: "Attempted automatic action",
          requestedBy: "96000000-0000-4000-8000-000000000001",
          evidence: {},
          evidenceHash: "e".repeat(64),
          idempotencyKey: "automatic-action-001",
        },
      },
    );
    assertStatus(automatic, 400);
    expect((await body(automatic)).code).toBe("AUTOMATIC_RECOVERY_PROHIBITED");
  } finally {
    await harness.close();
  }
});
