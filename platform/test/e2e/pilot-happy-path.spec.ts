import {
  expect,
  test,
} from "../../apps/customer-web/node_modules/@playwright/test/index.mjs";
import {
  applicantPersonId,
  applicationId,
  contractId,
  guarantorPersonId,
  startPilotHarness,
  vehicleModelId,
} from "./support/pilot-harness.js";
import {
  api,
  approveAllStages,
  assertStatus,
  body,
  call,
  completeOnboarding,
  createAndAcceptOffer,
  postPayment,
} from "./support/pilot-client.js";

test("runs the controlled pilot from applicant OTP through dual-approved ownership transfer", async ({
  page,
  request,
}) => {
  const harness = await startPilotHarness();
  try {
    await page.goto(harness.baseUrl);
    await page.getByLabel("Mobile number").fill("+233241000001");
    await page.getByRole("button", { name: "Send code" }).click();
    await expect(page.locator("#otp-result")).toHaveText("202");

    const client = api(request);
    await completeOnboarding(client, harness);
    expect(harness.state.application.status).toBe("VERIFICATION_REVIEW");

    await approveAllStages(client, harness);
    expect(harness.state.application.status).toBe("APPROVED");

    await createAndAcceptOffer(client, harness);
    expect(harness.state.offer?.status).toBe("ACCEPTED");

    const deposit = {
      eventId: "deposit-event-001",
      eventType: "PAYMENT_SUCCEEDED",
      providerTransactionId: "deposit-tx-001",
      payerPhoneE164: "+233241000001",
      customerReference: applicationId,
      channel: "MOBILE_MONEY",
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-23T12:00:00.000Z",
    };
    const firstDeposit = await postPayment(client, harness, deposit);
    assertStatus(firstDeposit, 202);
    const firstDepositBody = await body(firstDeposit);
    const replayDeposit = await postPayment(client, harness, deposit);
    assertStatus(replayDeposit, 202);
    await expect(body(replayDeposit)).resolves.toMatchObject({
      replay: true,
      ledgerEntryId: firstDepositBody.ledgerEntryId,
      receiptId: firstDepositBody.receiptId,
    });
    expect(harness.state.ledger).toHaveLength(1);
    expect(Object.keys(harness.state.receipts)).toHaveLength(1);

    const inventory = client;
    const vehicle = await call(
      inventory,
      harness.baseUrl,
      "post",
      "/v1/staff/assets",
      {
        token: harness.staffTokens.INVENTORY_OFFICER,
        body: {
          vehicleModelId,
          vin: "SYNTHETIC-VIN-001",
          chassisNumber: "SYNTHETIC-CHASSIS-001",
          engineMotorIdentifier: "SYNTHETIC-ENGINE-001",
          condition: { state: "NEW" },
          accessories: ["helmet"],
          trackerIdentifier: "TRACKER-001",
          idempotencyKey: "vehicle-register-001",
        },
      },
    );
    assertStatus(vehicle, 201);
    const vehicleBody = await body(vehicle);
    const assignment = await call(
      inventory,
      harness.baseUrl,
      "post",
      `/v1/staff/applications/${applicationId}/asset-assignment`,
      {
        token: harness.staffTokens.INVENTORY_OFFICER,
        body: {
          vehicleUnitId: String(vehicleBody.id),
          expectedVehicleVersion: 1,
          idempotencyKey: "assignment-001",
        },
      },
    );
    assertStatus(assignment, 200);
    const assignmentBody = await body(assignment);

    const operations = client;
    const generated = await call(
      operations,
      harness.baseUrl,
      "post",
      `/v1/staff/applications/${applicationId}/contracts`,
      {
        token: harness.staffTokens.OPERATIONS_OFFICER,
        body: {
          assignmentId: String(assignmentBody.id),
          idempotencyKey: "contract-generate-001",
        },
      },
    );
    assertStatus(generated, 201);
    const generatedBody = await body(generated);
    const acknowledged = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/customer/contracts/${contractId}/handover-acknowledgement`,
      {
        token: harness.applicantToken,
        body: {
          checklistVersion: "handover-v1",
          checklist: { lights: true, brakes: true },
          idempotencyKey: "handover-ack-001",
        },
      },
    );
    assertStatus(acknowledged, 201);
    const executed = await call(
      operations,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/execution`,
      {
        token: harness.staffTokens.OPERATIONS_OFFICER,
        body: {
          expectedVersion: Number(generatedBody.version),
          applicantPersonId,
          guarantorPersonId,
          staffWitnessId: "71000000-0000-4000-8000-000000000001",
          executionDate: "2026-08-23T12:00:00.000Z",
          headOfficeId: "HEAD-OFFICE-001",
          headOfficeLocation: "Accra",
          executedDocumentId: "72000000-0000-4000-8000-000000000001",
          executedDocumentHash: "d".repeat(64),
          idempotencyKey: "contract-execution-001",
        },
      },
    );
    assertStatus(executed, 200);
    const executedBody = await body(executed);
    const handedOver = await call(
      operations,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/handover`,
      {
        token: harness.staffTokens.OPERATIONS_OFFICER,
        body: {
          expectedVersion: Number(executedBody.version),
          checklistVersion: "handover-v1",
          checklist: { lights: true, brakes: true },
          customerAcknowledged: true,
          customerAcknowledgementId: "73000000-0000-4000-8000-000000000001",
          condition: { description: "New", checkResult: "PASS" },
          accessories: { items: ["helmet"] },
          headOfficeId: "HEAD-OFFICE-001",
          headOfficeLocation: "Accra",
          handedOverAt: "2026-08-23T12:00:00.000Z",
          idempotencyKey: "handover-001",
        },
      },
    );
    assertStatus(handedOver, 200);
    const handedOverBody = await body(handedOver);
    const activated = await call(
      operations,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/activate`,
      {
        token: harness.staffTokens.OPERATIONS_OFFICER,
        body: {
          expectedVersion: Number(handedOverBody.version),
          idempotencyKey: "activate-001",
        },
      },
    );
    assertStatus(activated, 200);
    expect((await body(activated)).ownershipHolder).toBe("SOMOCO");

    const repayment = await postPayment(client, harness, {
      eventId: "repayment-event-001",
      eventType: "PAYMENT_SUCCEEDED",
      providerTransactionId: "repayment-tx-001",
      payerPhoneE164: "+233241000001",
      customerReference: contractId,
      channel: "USSD",
      amount: { currency: "GHS", minorUnits: "30000" },
      occurredAt: "2026-08-23T12:05:00.000Z",
    });
    assertStatus(repayment, 202);
    expect(harness.state.contract?.outstandingBalanceMinor).toBe("0");
    expect(harness.state.ledger).toHaveLength(2);
    expect(Object.keys(harness.state.receipts)).toHaveLength(2);

    const finance = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/finance-approval`,
      {
        token: harness.staffTokens.FINANCE_OFFICER,
        body: {
          reason: "Ledger and provider totals reconciled",
          idempotencyKey: "finance-settlement-001",
        },
      },
    );
    assertStatus(finance, 200);
    const evidence = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/evidence`,
      {
        token: harness.staffTokens.INVENTORY_OFFICER,
        body: { evidenceDocumentId: "95000000-0000-4000-8000-000000000001" },
      },
    );
    assertStatus(evidence, 200);
    const business = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/business-approval`,
      {
        token: harness.staffTokens.MD,
        body: {
          reason: "Final ownership transfer review",
          idempotencyKey: "business-settlement-001",
        },
      },
    );
    assertStatus(business, 200);
    const settled = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/commit`,
      { token: harness.staffTokens.MD },
    );
    assertStatus(settled, 200);
    expect((await body(settled)).ownershipHolder).toBe("SOMOCO");
    const transferred = await call(
      client,
      harness.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/ownership-transfer`,
      { token: harness.staffTokens.MD },
    );
    assertStatus(transferred, 200);
    expect((await body(transferred)).ownershipHolder).toBe("CUSTOMER");
    expect(harness.state.settlement.transferred).toBe(true);
  } finally {
    await harness.close();
  }
});
