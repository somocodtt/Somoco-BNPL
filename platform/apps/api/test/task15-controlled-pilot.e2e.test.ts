import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { CanonicalPaymentEvent } from "../../../packages/integrations/src/index.js";
import { queryTestSql } from "../../../packages/testkit/src/index.js";
import {
  startRealPilot,
  type PilotRuntime,
} from "../../../test/e2e/support/real-pilot.js";
import {
  approveAllStages,
  body,
  call,
  completeOnboarding,
  createAndAcceptOffer,
  prepareContractWithoutSignatures,
  postPayment,
  type ApiRequest,
  type ApiResponse,
} from "../../../test/e2e/support/pilot-client.js";

const databaseUrl = "postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test";
process.env.TEST_DATABASE_URL = databaseUrl;

let runtime: PilotRuntime | undefined;

afterEach(async () => {
  await runtime?.close();
  runtime = undefined;
});

describe("Task 15 controlled pilot against the real app composition", () => {
  it("completes customer onboarding, durable approvals, and an accepted offer", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    const offer = await createAndAcceptOffer(request, flow);

    expect(offer).toMatchObject({
      status: "ACCEPTED",
      applicationId: flow.applicationId,
    });
    const application = await call(
      request,
      runtime.baseUrl,
      "get",
      `/v1/staff/applications/${flow.applicationId}`,
      {
        headers: runtime.staff.get("MD")!.headers,
      },
    );
    expect(application.status()).toBe(200);
    await expect(body(application)).resolves.toMatchObject({
      status: "APPROVED",
    });

    const approvalEvidence = await queryTestSql<{
      approval_count: string;
      stage_count: string;
      actor_count: string;
      idempotency_count: string;
    }>(
      databaseUrl,
      `select count(*) filter (where action = 'APPLICATION_APPROVAL_DECIDED')::text as approval_count,
              count(distinct data->>'stage') filter (where action = 'APPLICATION_APPROVAL_DECIDED')::text as stage_count,
              count(distinct actor_staff_user_id) filter (where action = 'APPLICATION_APPROVAL_DECIDED')::text as actor_count,
              count(*) filter (where action = 'APPLICATION_APPROVAL_DECIDED' and data ? 'idempotencyKey')::text as idempotency_count
         from audit_event
        where aggregate_type = 'application' and aggregate_id = $1`,
      [flow.applicationId],
    );
    expect(approvalEvidence).toEqual({
      approval_count: "6",
      stage_count: "6",
      actor_count: "5",
      idempotency_count: "6",
    });

    const guarantorEvidence = await queryTestSql<{
      consent_count: string;
      identity_count: string;
      document_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from privacy.consent_evidence where person_id = $1 and purpose = 'NIA_IDENTITY_VERIFICATION')::text as consent_count,
          (select count(*) from privacy.identity_check where person_id = $1 and status = 'VERIFIED')::text as identity_count,
          (select count(*) from privacy.document where person_id = $1 and status = 'ACCEPTED')::text as document_count`,
      [runtime.applicationFixtures.guarantorId],
    );
    expect(guarantorEvidence).toEqual({
      consent_count: "1",
      identity_count: "1",
      document_count: "1",
    });

    const applicantSignature = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/applications/${flow.applicationId}/signatures`,
      {
        headers: runtime.customer.applicant.headers,
        body: {
          signature: "applicant-signature-controlled-pilot-v1",
          idempotencyKey: "pilot-applicant-signature-001",
        },
      },
    );
    expect(applicantSignature.status()).toBe(201);
    const applicantSignatureBody = await body(applicantSignature);
    expect(applicantSignatureBody).toMatchObject({
      applicationId: flow.applicationId,
      personId: runtime.applicationFixtures.applicantId,
      purpose: "CONTRACT_EXECUTION",
      replay: false,
    });
    const applicantSignatureReplay = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/applications/${flow.applicationId}/signatures`,
      {
        headers: runtime.customer.applicant.headers,
        body: {
          signature: "applicant-signature-controlled-pilot-v1",
          idempotencyKey: "pilot-applicant-signature-001",
        },
      },
    );
    expect(applicantSignatureReplay.status()).toBe(201);
    await expect(body(applicantSignatureReplay)).resolves.toMatchObject({
      id: applicantSignatureBody.id,
      replay: true,
    });

    const guarantorSignature = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/applications/${flow.applicationId}/signatures`,
      {
        headers: runtime.customer.guarantor.headers,
        body: {
          signature: "guarantor-signature-controlled-pilot-v1",
          idempotencyKey: "pilot-guarantor-signature-001",
        },
      },
    );
    expect(guarantorSignature.status()).toBe(201);
    await expect(body(guarantorSignature)).resolves.toMatchObject({
      applicationId: flow.applicationId,
      personId: runtime.applicationFixtures.guarantorId,
      purpose: "CONTRACT_EXECUTION",
      replay: false,
    });

    const signatures = await queryTestSql<{
      signature_count: string;
      applicant_count: string;
      guarantor_count: string;
    }>(
      databaseUrl,
      `select count(*)::text as signature_count,
              count(*) filter (where person_id = $2)::text as applicant_count,
              count(*) filter (where person_id = $3)::text as guarantor_count
         from privacy.signature_evidence
        where purpose = 'CONTRACT_EXECUTION'
          and evidence->>'applicationId' = $1`,
      [
        flow.applicationId,
        runtime.applicationFixtures.applicantId,
        runtime.applicationFixtures.guarantorId,
      ],
    );
    expect(signatures).toEqual({
      signature_count: "2",
      applicant_count: "1",
      guarantor_count: "1",
    });

    const depositEvent: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-deposit-event-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId: "controlled-pilot-deposit-provider-001",
      payerPhoneE164: "+233241000001",
      customerReference: flow.applicationId,
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-02T12:10:00.000Z",
    };
    const deposit = await postPayment(request, flow, depositEvent);
    expect(deposit.status()).toBe(202);
    const depositAcknowledgement = await body(deposit);
    expect(depositAcknowledgement).toMatchObject({
      accepted: true,
      duplicate: false,
      outcome: "POSTED",
      depositReconciled: true,
    });
    const receiptId = String(depositAcknowledgement.receiptId);
    const paymentTransactionId = String(
      depositAcknowledgement.paymentTransactionId,
    );
    expect(receiptId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(paymentTransactionId).toMatch(/^[0-9a-f-]{36}$/i);
    const depositEvidence = await queryTestSql<{
      payment_count: string;
      receipt_count: string;
      receipt_contract_count: string;
      reconciled_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction where provider_transaction_id = $1)::text as payment_count,
          (select count(*) from payment_receipt pr join payment_transaction p on p.id = pr.payment_transaction_id where p.provider_transaction_id = $1)::text as receipt_count,
          (select count(*) from payment_receipt pr join payment_transaction p on p.id = pr.payment_transaction_id where p.provider_transaction_id = $1 and pr.contract_id is not null)::text as receipt_contract_count,
          (select count(*) from deposit_reconciliation where application_id = $2 and status = 'RECONCILED')::text as reconciled_count`,
      [depositEvent.providerTransactionId, flow.applicationId],
    );
    expect(depositEvidence).toEqual({
      payment_count: "1",
      receipt_count: "1",
      receipt_contract_count: "0",
      reconciled_count: "1",
    });

    const vehicle = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/staff/assets",
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          vehicleModelId: runtime.applicationFixtures.vehicleModelId,
          vin: "CONTROLLED-PILOT-FLOW-VIN-001",
          chassisNumber: "CONTROLLED-PILOT-FLOW-CHASSIS-001",
          engineMotorIdentifier: "CONTROLLED-PILOT-FLOW-ENGINE-001",
          condition: { state: "NEW" },
          accessories: ["helmet"],
          trackerIdentifier: "CONTROLLED-PILOT-FLOW-TRACKER-001",
          idempotencyKey: "pilot-flow-vehicle-001",
        },
      },
    );
    expect(vehicle.status()).toBe(201);
    const vehicleBody = await body(vehicle);
    const vehicleId = String(vehicleBody.id);
    let vehicleVersion = Number(vehicleBody.version);

    const registration = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/assets/${vehicleId}/registration`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          registrationNumber: "GT-FLOW-26",
          validFrom: "2026-08-01",
          validTo: "2027-08-01",
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: "pilot-flow-registration-001",
        },
      },
    );
    expect(registration.status()).toBe(200);
    vehicleVersion = Number((await body(registration)).version);

    const insurance = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/assets/${vehicleId}/insurance`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          policyNumber: "CONTROLLED-PILOT-FLOW-POLICY-001",
          provider: "Controlled Pilot Insurer",
          validFrom: "2026-08-01",
          validTo: "2027-08-01",
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: "pilot-flow-insurance-001",
        },
      },
    );
    expect(insurance.status()).toBe(200);
    vehicleVersion = Number((await body(insurance)).version);

    const assignment = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/asset-assignment`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          vehicleUnitId: vehicleId,
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: "pilot-flow-assignment-001",
        },
      },
    );
    expect(assignment.status()).toBe(200);
    await expect(body(assignment)).resolves.toMatchObject({
      applicationId: flow.applicationId,
      vehicleUnitId: vehicleId,
    });

    const generatedContract = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/contracts`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          assignmentId: String((await body(assignment)).id),
          idempotencyKey: "pilot-flow-contract-generate-001",
        },
      },
    );
    expect(generatedContract.status()).toBe(201);
    const contractBody = await body(generatedContract);
    expect(contractBody).toMatchObject({
      applicationId: flow.applicationId,
      status: "AWAITING_EXECUTION",
    });
    const contractId = String(contractBody.id);
    const depositBinding = await queryTestSql<{
      payment_status: string;
      contract_id: string;
      receipt_contract_id: string | null;
      deposit_ledger_count: string;
    }>(
      databaseUrl,
      `select p.status as payment_status,
              p.contract_id::text as contract_id,
              (select pr.contract_id::text from payment_receipt pr where pr.payment_transaction_id = p.id) as receipt_contract_id,
              (select count(*) from ledger_entry l
                where l.contract_id = p.contract_id
                  and l.payment_transaction_id = p.id
                  and l.entry_type = 'DEPOSIT')::text as deposit_ledger_count
         from payment_transaction p
        where p.provider_transaction_id = $1`,
      [depositEvent.providerTransactionId],
    );
    expect(depositBinding).toEqual({
      payment_status: "POSTED",
      contract_id: contractId,
      receipt_contract_id: contractId,
      deposit_ledger_count: "1",
    });

    const customerReceiptList = await call(
      request,
      runtime.baseUrl,
      "get",
      "/v1/customer/receipts",
      { headers: runtime.customer.applicant.headers },
    );
    expect(customerReceiptList.status()).toBe(200);
    await expect(customerReceiptList.json()).resolves.toEqual([
      expect.objectContaining({
        id: receiptId,
        paymentTransactionId,
        amountMinorUnits: "10000",
      }),
    ]);
    const customerReceipt = await call(
      request,
      runtime.baseUrl,
      "get",
      `/v1/customer/receipts/${receiptId}`,
      { headers: runtime.customer.applicant.headers },
    );
    expect(customerReceipt.status()).toBe(200);
    await expect(body(customerReceipt)).resolves.toMatchObject({
      id: receiptId,
      paymentTransactionId,
      providerTransactionId: depositEvent.providerTransactionId,
      status: "POSTED",
    });

    const execution = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/execution`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          expectedVersion: Number(contractBody.version),
          applicantPersonId: runtime.applicationFixtures.applicantId,
          guarantorPersonId: runtime.applicationFixtures.guarantorId,
          staffWitnessId: runtime.staff.get("INVENTORY_OFFICER")!.staffUserId,
          executionDate: "2026-08-03T12:00:00.000Z",
          headOfficeId: "CONTROLLED-PILOT-HEAD-OFFICE",
          headOfficeLocation: "Accra",
          executedDocumentId: flow.applicantDocumentId,
          executedDocumentHash: flow.applicantDocumentHash,
          idempotencyKey: "pilot-flow-contract-execution-001",
        },
      },
    );
    expect(execution.status(), await execution.text()).toBe(200);
    await expect(body(execution)).resolves.toMatchObject({
      id: contractId,
      status: "EXECUTED",
    });

    const handoverChecklist = {
      items: [
        { itemId: "identity_verified", result: "PASS" },
        { itemId: "keys_received", result: "PASS" },
        { itemId: "condition_recorded", result: "PASS" },
        { itemId: "accessories_recorded", result: "PASS" },
      ],
    };
    const acknowledgement = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/contracts/${contractId}/handover-acknowledgement`,
      {
        headers: runtime.customer.applicant.headers,
        body: {
          checklistVersion: "handover-v1",
          checklist: handoverChecklist,
          idempotencyKey: "pilot-flow-handover-ack-001",
        },
      },
    );
    expect(acknowledgement.status()).toBe(201);
    const acknowledgementBody = await body(acknowledgement);

    const handover = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/handover`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          expectedVersion: Number((await body(execution)).version),
          checklistVersion: "handover-v1",
          checklist: handoverChecklist,
          customerAcknowledged: true,
          customerAcknowledgementId: String(acknowledgementBody.id),
          customerAcknowledgedByPersonId:
            runtime.applicationFixtures.applicantId,
          condition: {
            description: "New vehicle inspected with no visible damage.",
            checkResult: "PASS",
          },
          accessories: { items: ["helmet"] },
          headOfficeId: "CONTROLLED-PILOT-HEAD-OFFICE",
          headOfficeLocation: "Accra",
          handedOverAt: "2026-08-04T12:00:00.000Z",
          idempotencyKey: "pilot-flow-handover-001",
        },
      },
    );
    expect(handover.status()).toBe(200);
    await expect(body(handover)).resolves.toMatchObject({
      id: contractId,
      status: "EXECUTED",
    });

    const activation = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/activate`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          expectedVersion: Number((await body(handover)).version),
          idempotencyKey: "pilot-flow-contract-activation-001",
        },
      },
    );
    expect(activation.status()).toBe(200);
    await expect(body(activation)).resolves.toMatchObject({
      id: contractId,
      status: "ACTIVE",
      ownershipHolder: "SOMOCO",
    });
    const schedule = await queryTestSql<{
      schedule_count: string;
      schedule_total: string;
      installment_count: string;
      installment_total: string;
    }>(
      databaseUrl,
      `select count(*)::text as schedule_count,
              coalesce(sum(total_minor_units), 0)::text as schedule_total,
              (select count(*) from installment where contract_id = $1)::text as installment_count,
              (select coalesce(sum(amount_minor_units), 0) from installment where contract_id = $1)::text as installment_total
         from repayment_schedule
        where contract_id = $1`,
      [contractId],
    );
    expect(schedule).toEqual({
      schedule_count: "1",
      schedule_total: "90000",
      installment_count: "6",
      installment_total: "90000",
    });

    const arrears = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/arrears/compute`,
      {
        headers: runtime.staff.get("RECOVERY_OFFICER")!.headers,
        body: { asOfDate: "2027-04-01" },
      },
    );
    expect(arrears.status(), await arrears.text()).toBe(200);
    await expect(body(arrears)).resolves.toMatchObject({
      contractId,
      totalUnpaid: 6,
      consecutiveMissed: 6,
      escalationSignals: ["THREE_CONSECUTIVE_MISSED", "THREE_TOTAL_UNPAID"],
    });
    const arrearsAudit = await queryTestSql<{
      actor_staff_user_id: string | null;
      request_id: string | null;
    }>(
      databaseUrl,
      `select actor_staff_user_id::text as actor_staff_user_id,
              request_id
         from audit_event
        where aggregate_type = 'contract'
          and aggregate_id = $1
          and action = 'ARREARS_COMPUTED'
        order by occurred_at desc
        limit 1`,
      [contractId],
    );
    expect(arrearsAudit).toEqual({
      actor_staff_user_id: runtime.staff.get("RECOVERY_OFFICER")!.staffUserId,
      request_id: expect.any(String),
    });

    const repaymentEvents: CanonicalPaymentEvent[] = Array.from(
      { length: 6 },
      (_, index) => ({
        eventId: `controlled-pilot-repayment-event-00${index + 1}`,
        eventType: "PAYMENT_SUCCEEDED" as const,
        channel: "MOBILE_MONEY" as const,
        providerTransactionId: `controlled-pilot-repayment-provider-00${index + 1}`,
        payerPhoneE164: "+233241000001",
        customerReference: contractId,
        amount: { currency: "GHS" as const, minorUnits: "15000" },
        occurredAt: `2026-08-22T12:${String(10 + index).padStart(2, "0")}:00.000Z`,
      }),
    );
    for (const repaymentEvent of repaymentEvents) {
      const repayment = await postPayment(request, flow, repaymentEvent);
      expect(repayment.status()).toBe(202);
      await expect(body(repayment)).resolves.toMatchObject({
        accepted: true,
        duplicate: false,
        outcome: "POSTED",
      });
    }
    const repaymentEvent = repaymentEvents[0]!;
    const repaymentReplay = await postPayment(request, flow, {
      ...repaymentEvent,
      eventId: "controlled-pilot-repayment-event-replay",
    });
    expect(repaymentReplay.status()).toBe(202);
    await expect(body(repaymentReplay)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      outcome: "POSTED",
    });
    const repaymentEvidence = await queryTestSql<{
      transaction_count: string;
      receipt_count: string;
      repayment_ledger_count: string;
      installment_status: string;
      outstanding_balance: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction where provider_transaction_id = $1)::text as transaction_count,
          (select count(*) from payment_receipt pr join payment_transaction p on p.id = pr.payment_transaction_id where p.provider_transaction_id = $1)::text as receipt_count,
          (select count(*) from ledger_entry l join payment_transaction p on p.id = l.payment_transaction_id where p.provider_transaction_id = $1 and l.entry_type = 'REPAYMENT')::text as repayment_ledger_count,
          (select status::text from installment where contract_id = $2 order by installment_number limit 1) as installment_status,
          (select outstanding_balance_minor_units::text from contract where id = $2) as outstanding_balance`,
      [repaymentEvent.providerTransactionId, contractId],
    );
    expect(repaymentEvidence).toEqual({
      transaction_count: "1",
      receipt_count: "1",
      repayment_ledger_count: "1",
      installment_status: "PAID",
      outstanding_balance: "0",
    });

    const evidence = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/evidence`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: { evidenceDocumentId: flow.transferEvidenceDocumentId },
      },
    );
    expect(evidence.status()).toBe(200);
    await expect(body(evidence)).resolves.toMatchObject({
      contractId,
      evidenceDocumentId: flow.transferEvidenceDocumentId,
      verificationStatus: "CLEAN",
    });

    const financeApproval = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/finance-approval`,
      {
        headers: runtime.staff.get("FINANCE_OFFICER")!.headers,
        body: {
          reason: "All simulator receipts and ledger postings reconciled.",
          idempotencyKey: "pilot-flow-finance-approval-001",
        },
      },
    );
    expect(financeApproval.status()).toBe(200);
    await expect(body(financeApproval)).resolves.toMatchObject({
      contractId,
      approvalType: "FINANCE_RECONCILIATION",
    });

    const businessApproval = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/business-approval`,
      {
        headers: runtime.staff.get("MD")!.headers,
        body: {
          reason: "Ownership transfer evidence and handover are complete.",
          idempotencyKey: "pilot-flow-business-approval-001",
        },
      },
    );
    expect(businessApproval.status()).toBe(200);
    await expect(body(businessApproval)).resolves.toMatchObject({
      contractId,
      approvalType: "BUSINESS_OWNERSHIP_TRANSFER",
    });

    const settlement = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/settlement/commit`,
      { headers: runtime.staff.get("FINANCE_OFFICER")!.headers },
    );
    expect(settlement.status()).toBe(200);
    await expect(body(settlement)).resolves.toMatchObject({
      contractId,
      status: "SETTLED",
      ownershipHolder: "SOMOCO",
    });

    const transfer = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contractId}/ownership-transfer`,
      { headers: runtime.staff.get("MD")!.headers },
    );
    expect(transfer.status()).toBe(200);
    await expect(body(transfer)).resolves.toMatchObject({
      contractId,
      status: "TRANSFERRED",
      ownershipHolder: "CUSTOMER",
    });
    const ownershipEvidence = await queryTestSql<{
      contract_status: string;
      ownership_holder: string;
      vehicle_status: string;
      registration_owner: string;
      registration_evidence_id: string | null;
      transfer_evidence_id: string | null;
      finance_approvals: string;
      business_approvals: string;
      transfer_count: string;
      transfer_status: string;
    }>(
      databaseUrl,
      `select c.status as contract_status,
              c.ownership_holder,
              vehicle.status::text as vehicle_status,
              registration.registered_owner::text as registration_owner,
              registration.evidence_document_id::text as registration_evidence_id,
              transfer.evidence->>'registrationEvidenceDocumentId' as transfer_evidence_id,
              (select count(*) from settlement_approval where contract_id = c.id and approval_type = 'FINANCE_RECONCILIATION')::text as finance_approvals,
              (select count(*) from settlement_approval where contract_id = c.id and approval_type = 'BUSINESS_OWNERSHIP_TRANSFER')::text as business_approvals,
              (select count(*) from ownership_transfer where contract_id = c.id)::text as transfer_count,
              transfer.status::text as transfer_status
         from contract c
         join vehicle_unit vehicle on vehicle.id = c.vehicle_unit_id
         join ownership_transfer transfer on transfer.contract_id = c.id
         join lateral (
           select * from registration_record record
            where record.vehicle_unit_id = vehicle.id
            order by record.created_at desc, record.id desc limit 1
         ) registration on true
        where c.id = $1`,
      [contractId],
    );
    expect(ownershipEvidence).toEqual({
      contract_status: "TRANSFERRED",
      ownership_holder: "CUSTOMER",
      vehicle_status: "TRANSFERRED",
      registration_owner: "CUSTOMER",
      registration_evidence_id: flow.transferEvidenceDocumentId,
      transfer_evidence_id: flow.transferEvidenceDocumentId,
      finance_approvals: "1",
      business_approvals: "1",
      transfer_count: "1",
      transfer_status: "COMPLETED",
    });

    const freshStaffContract = await call(
      request,
      runtime.baseUrl,
      "get",
      `/v1/staff/applications/${flow.applicationId}/contract`,
      { headers: runtime.staff.get("INVENTORY_OFFICER")!.headers },
    );
    expect(freshStaffContract.status()).toBe(200);
    await expect(body(freshStaffContract)).resolves.toMatchObject({
      status: "TRANSFERRED",
      ownershipHolder: "CUSTOMER",
    });
    const freshCustomerContract = await call(
      request,
      runtime.baseUrl,
      "get",
      `/v1/customer/applications/${flow.applicationId}/contract`,
      { headers: runtime.customer.applicant.headers },
    );
    expect(freshCustomerContract.status()).toBe(200);
    await expect(body(freshCustomerContract)).resolves.toMatchObject({
      status: "TRANSFERRED",
      ownershipHolder: "CUSTOMER",
      vehicleStatus: "TRANSFERRED",
      registrationOwner: "CUSTOMER",
    });
  }, 60_000);

  it("rejects a wrong-role approval and licence-disallowed tenure at public boundaries", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);

    const wrongRole = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/approve`,
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: {
          expectedVersion: await currentVersion(
            request,
            runtime,
            flow.applicationId,
          ),
          stage: "VERIFICATION",
          note: "A support role must not approve underwriting.",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(wrongRole.status()).toBe(403);
    await expect(body(wrongRole)).resolves.toMatchObject({ code: "FORBIDDEN" });

    await approveAllStages(request, flow);
    const disallowedTenure = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/customer/applications/${flow.applicationId}/offers`,
      {
        headers: runtime.customer.applicant.headers,
        body: {
          depositMinor: "10000",
          frequency: "MONTHLY",
          tenureMonths: 12,
          firstDueDate: "2026-08-15",
          expiresAt: "2026-08-31T00:00:00.000Z",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(disallowedTenure.status()).toBe(400);
    await expect(body(disallowedTenure)).resolves.toMatchObject({
      code: "TENURE_NOT_ALLOWED",
    });
  }, 60_000);

  it("rejects physical execution when public applicant and guarantor signatures are absent", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    const contract = await prepareContractWithoutSignatures(request, flow);
    const execution = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${contract.contractId}/execution`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          expectedVersion: contract.contractVersion,
          applicantPersonId: runtime.applicationFixtures.applicantId,
          guarantorPersonId: runtime.applicationFixtures.guarantorId,
          staffWitnessId: runtime.staff.get("INVENTORY_OFFICER")!.staffUserId,
          executionDate: "2026-08-03T12:00:00.000Z",
          headOfficeId: "CONTROLLED-PILOT-HEAD-OFFICE",
          headOfficeLocation: "Accra",
          executedDocumentId: flow.applicantDocumentId,
          executedDocumentHash: flow.applicantDocumentHash,
          idempotencyKey: "pilot-signature-gate-execution-001",
        },
      },
    );
    expect(execution.status()).toBe(409);
    await expect(body(execution)).resolves.toMatchObject({
      code: "SIGNATURE_EVIDENCE_INCOMPLETE",
    });
  }, 60_000);

  it("replays an unmatched simulator payment without a second transaction or reconciliation case", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);

    const event: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-unmatched-payment-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId: "controlled-pilot-provider-transaction-001",
      payerPhoneE164: "+233241000001",
      customerReference: "CONTRACT-REFERENCE-NOT-FOUND",
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-01T12:10:00.000Z",
    };
    const first = await postPayment(request, flow, event);
    expect(first.status()).toBe(202);
    await expect(body(first)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      outcome: "QUARANTINED",
      reason: "UNMATCHED_CUSTOMER_REFERENCE",
    });
    const replay = await postPayment(request, flow, {
      ...event,
      eventId: "controlled-pilot-unmatched-payment-002",
    });
    expect(replay.status()).toBe(202);
    await expect(body(replay)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
      outcome: "QUARANTINED",
    });

    const persisted = await queryTestSql<{
      payment_count: string;
      case_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction where provider_transaction_id = $1)::text as payment_count,
          (select count(*) from reconciliation_case rc join payment_transaction p on p.id = rc.payment_transaction_id where p.provider_transaction_id = $1)::text as case_count`,
      [event.providerTransactionId],
    );
    expect(persisted).toEqual({ payment_count: "1", case_count: "1" });
  }, 60_000);

  it("keeps one winning pre-contract deposit and quarantines a concurrent distinct payment", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);

    const firstEvent: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-concurrent-deposit-event-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId: "controlled-pilot-concurrent-deposit-provider-001",
      payerPhoneE164: "+233241000001",
      customerReference: flow.applicationId,
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-02T12:10:00.000Z",
    };
    const secondEvent: CanonicalPaymentEvent = {
      ...firstEvent,
      eventId: "controlled-pilot-concurrent-deposit-event-002",
      providerTransactionId: "controlled-pilot-concurrent-deposit-provider-002",
    };
    const [first, second] = await Promise.all([
      postPayment(request, flow, firstEvent),
      postPayment(request, flow, secondEvent),
    ]);
    expect(first.status()).toBe(202);
    expect(second.status()).toBe(202);
    const outcomes = await Promise.all([body(first), body(second)]);
    expect(outcomes.map((item) => item.outcome).sort()).toEqual([
      "POSTED",
      "QUARANTINED",
    ]);
    expect(
      outcomes.filter((item) => item.depositReconciled === true),
    ).toHaveLength(1);
    expect(
      outcomes.find((item) => item.outcome === "QUARANTINED"),
    ).toMatchObject({
      reason: "DEPOSIT_ALREADY_RECONCILED",
    });

    const persisted = await queryTestSql<{
      payment_count: string;
      reconciled_count: string;
      receipt_count: string;
      case_count: string;
      winner_payment_count: string;
      loser_case_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction where provider_transaction_id in ($1, $2))::text as payment_count,
          (select count(*) from deposit_reconciliation where application_id = $3 and status = 'RECONCILED')::text as reconciled_count,
          (select count(*) from payment_receipt pr join payment_transaction p on p.id = pr.payment_transaction_id where p.provider_transaction_id in ($1, $2))::text as receipt_count,
          (select count(*) from reconciliation_case rc join payment_transaction p on p.id = rc.payment_transaction_id where p.provider_transaction_id in ($1, $2))::text as case_count,
          (select count(*) from deposit_reconciliation dr join payment_transaction p on p.id = dr.payment_transaction_id where p.provider_transaction_id in ($1, $2))::text as winner_payment_count,
          (select count(*) from reconciliation_case rc join payment_transaction p on p.id = rc.payment_transaction_id where p.provider_transaction_id in ($1, $2) and rc.reason = 'DEPOSIT_ALREADY_RECONCILED')::text as loser_case_count`,
      [
        firstEvent.providerTransactionId,
        secondEvent.providerTransactionId,
        flow.applicationId,
      ],
    );
    expect(persisted).toEqual({
      payment_count: "2",
      reconciled_count: "1",
      receipt_count: "1",
      case_count: "1",
      winner_payment_count: "1",
      loser_case_count: "1",
    });
  }, 60_000);

  it("rejects arrears computation for a non-collections role and audits the denial", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const response = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/contracts/${randomUUID()}/arrears/compute`,
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: { asOfDate: "2027-04-01" },
      },
    );
    expect(response.status()).toBe(403);
    await expect(body(response)).resolves.toMatchObject({ code: "FORBIDDEN" });
    const denied = await queryTestSql<{
      action: string;
      actor_staff_user_id: string;
    }>(
      databaseUrl,
      `select action, actor_staff_user_id::text as actor_staff_user_id
         from audit_event
        where aggregate_type = 'access_control'
          and action = 'ACCESS_DENIED'
          and data->>'action' = 'collections.compute'
        order by occurred_at desc
        limit 1`,
    );
    expect(denied).toEqual({
      action: "ACCESS_DENIED",
      actor_staff_user_id: runtime.staff.get("CUSTOMER_SUPPORT")!.staffUserId,
    });
  }, 60_000);

  it("preserves a provider-outage payment for retry, then posts one idempotent recovery", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);
    const event: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-provider-outage-event-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId: "controlled-pilot-provider-outage-provider-001",
      payerPhoneE164: "+233241000001",
      customerReference: flow.applicationId,
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-02T12:11:00.000Z",
    };
    runtime.controls.setPaymentAvailable(false);
    const outage = await postPayment(request, flow, event);
    expect(outage.status()).toBe(503);
    await expect(body(outage)).resolves.toMatchObject({
      code: "PAYMENT_PROVIDER_UNAVAILABLE",
    });
    const preserved = await queryTestSql<{
      payment_count: string;
      processed_count: string;
      raw_body_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction where provider_transaction_id = $1)::text as payment_count,
          (select count(*) from inbox_message where provider = 'SOMOCO_PAYMENTS' and provider_event_id like 'unverified:sha256:%' and processed_at is not null)::text as processed_count,
          (select count(*) from inbox_message where provider = 'SOMOCO_PAYMENTS' and provider_event_id like 'unverified:sha256:%' and payload->>'rawBodyBase64' is not null)::text as raw_body_count`,
      [event.providerTransactionId],
    );
    expect(preserved).toEqual({
      payment_count: "0",
      processed_count: "0",
      raw_body_count: "1",
    });

    runtime.controls.setPaymentAvailable(true);
    const recovered = await postPayment(request, flow, event);
    expect(recovered.status(), await recovered.text()).toBe(202);
    await expect(body(recovered)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      outcome: "POSTED",
      depositReconciled: true,
    });
    const replay = await postPayment(request, flow, event);
    expect(replay.status()).toBe(202);
    await expect(body(replay)).resolves.toMatchObject({
      accepted: true,
      duplicate: false,
      outcome: "POSTED",
    });
    const recoveredEvidence = await queryTestSql<{
      payment_count: string;
      processed_count: string;
      receipt_count: string;
    }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction where provider_transaction_id = $1)::text as payment_count,
          (select count(*) from inbox_message where provider = 'SOMOCO_PAYMENTS' and provider_event_id = $2 and processed_at is not null)::text as processed_count,
          (select count(*) from payment_receipt pr join payment_transaction p on p.id = pr.payment_transaction_id where p.provider_transaction_id = $1)::text as receipt_count`,
      [event.providerTransactionId, event.eventId],
    );
    expect(recoveredEvidence).toEqual({
      payment_count: "1",
      processed_count: "1",
      receipt_count: "1",
    });
  }, 60_000);

  it("enforces inventory-officer ownership, registration, insurance, and deposit guards", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    await approveAllStages(request, flow);
    await createAndAcceptOffer(request, flow);

    const vehicle = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/staff/assets",
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          vehicleModelId: runtime.applicationFixtures.vehicleModelId,
          vin: "CONTROLLED-PILOT-VIN-001",
          chassisNumber: "CONTROLLED-PILOT-CHASSIS-001",
          engineMotorIdentifier: "CONTROLLED-PILOT-ENGINE-001",
          condition: { state: "NEW" },
          accessories: ["helmet"],
          trackerIdentifier: "CONTROLLED-PILOT-TRACKER-001",
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(vehicle.status()).toBe(201);
    const vehicleBody = await body(vehicle);
    const vehicleId = String(vehicleBody.id);
    let vehicleVersion = Number(vehicleBody.version);

    const registration = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/assets/${vehicleId}/registration`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          registrationNumber: "GT-001-26",
          validFrom: "2026-08-01",
          validTo: "2027-08-01",
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(registration.status()).toBe(200);
    vehicleVersion = Number((await body(registration)).version);

    const insurance = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/assets/${vehicleId}/insurance`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          policyNumber: "CONTROLLED-PILOT-POLICY-001",
          provider: "Controlled Pilot Insurer",
          validFrom: "2026-08-01",
          validTo: "2027-08-01",
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(insurance.status()).toBe(200);
    vehicleVersion = Number((await body(insurance)).version);

    const wrongRole = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/asset-assignment`,
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: {
          vehicleUnitId: vehicleId,
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(wrongRole.status()).toBe(403);
    await expect(body(wrongRole)).resolves.toMatchObject({ code: "FORBIDDEN" });

    const missingDeposit = await call(
      request,
      runtime.baseUrl,
      "post",
      `/v1/staff/applications/${flow.applicationId}/asset-assignment`,
      {
        headers: runtime.staff.get("INVENTORY_OFFICER")!.headers,
        body: {
          vehicleUnitId: vehicleId,
          expectedVehicleVersion: vehicleVersion,
          idempotencyKey: randomUUID(),
        },
      },
    );
    expect(missingDeposit.status()).toBe(409);
    await expect(body(missingDeposit)).resolves.toMatchObject({
      code: "DEPOSIT_RECONCILIATION_REQUIRED",
    });
  }, 60_000);

  it("fails closed for provider verification and recovery-role boundaries", async () => {
    runtime = await startRealPilot();
    const request = injectRequest(runtime.app);
    const flow = await completeOnboarding(request, runtime);
    const before = await queryTestSql<{ payments: string; inbox: string }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction)::text as payments,
          (select count(*) from inbox_message where provider = 'SOMOCO_PAYMENTS')::text as inbox`,
    );
    const event: CanonicalPaymentEvent = {
      eventId: "controlled-pilot-invalid-provider-event-001",
      eventType: "PAYMENT_SUCCEEDED",
      channel: "MOBILE_MONEY",
      providerTransactionId:
        "controlled-pilot-invalid-provider-transaction-001",
      payerPhoneE164: "+233241000001",
      customerReference: flow.applicationId,
      amount: { currency: "GHS", minorUnits: "10000" },
      occurredAt: "2026-08-01T12:15:00.000Z",
    };
    const invalid = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/integrations/payments/somoco",
      {
        headers: {
          "content-type": "application/json",
          "x-payment-signature": "not-a-registered-simulator-signature",
          "x-payment-timestamp": event.occurredAt,
        },
        body: event as unknown as Record<string, unknown>,
      },
    );
    expect(invalid.status()).toBe(401);
    await expect(body(invalid)).resolves.toMatchObject({
      code: "PAYMENT_VERIFICATION_FAILED",
    });

    const recovery = await call(
      request,
      runtime.baseUrl,
      "get",
      "/v1/staff/collections/arrears",
      {
        headers: runtime.staff.get("RECOVERY_OFFICER")!.headers,
      },
    );
    expect(recovery.status()).toBe(200);
    await expect(recovery.json()).resolves.toEqual([]);
    const supportRecovery = await call(
      request,
      runtime.baseUrl,
      "post",
      "/v1/staff/collections/cases",
      {
        headers: runtime.staff.get("CUSTOMER_SUPPORT")!.headers,
        body: {
          contractId: randomUUID(),
          purpose: "CONTROLLED_PILOT_ROLE_CHECK",
          reason: "A support role must not open a recovery case.",
        },
      },
    );
    expect(supportRecovery.status()).toBe(403);
    await expect(body(supportRecovery)).resolves.toMatchObject({
      code: "FORBIDDEN",
    });

    const after = await queryTestSql<{ payments: string; inbox: string }>(
      databaseUrl,
      `select
          (select count(*) from payment_transaction)::text as payments,
          (select count(*) from inbox_message where provider = 'SOMOCO_PAYMENTS')::text as inbox`,
    );
    expect(after).toEqual(before);
  }, 60_000);
});

async function currentVersion(
  request: ApiRequest,
  runtime: PilotRuntime,
  applicationId: string,
): Promise<number> {
  const response = await call(
    request,
    runtime.baseUrl,
    "get",
    `/v1/staff/applications/${applicationId}`,
    {
      headers: runtime.staff.get("VERIFICATION_OFFICER")!.headers,
    },
  );
  expect(response.status()).toBe(200);
  return Number((await body(response)).version);
}

function injectRequest(app: FastifyInstance): ApiRequest {
  return {
    get: (url, options) => inject(app, "GET", url, options),
    post: (url, options) => inject(app, "POST", url, options),
    patch: (url, options) => inject(app, "PATCH", url, options),
  };
}

async function inject(
  app: FastifyInstance,
  method: "GET" | "POST" | "PATCH",
  url: string,
  options: Record<string, unknown> = {},
): Promise<ApiResponse> {
  const headers = (options.headers ?? {}) as Record<string, string>;
  const parsedUrl = new URL(url);
  const injectOptions: {
    method: "GET" | "POST" | "PATCH";
    url: string;
    headers: Record<string, string>;
    payload?: string;
  } = {
    method,
    url: `${parsedUrl.pathname}${parsedUrl.search}`,
    headers,
  };
  if (options.data !== undefined)
    injectOptions.payload = JSON.stringify(options.data);
  const response = await app.inject(injectOptions);
  return {
    status: () => response.statusCode,
    json: async () => response.json(),
    text: async () => response.body,
  };
}
