import { createHmac, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

export const applicantPhone = "+233241000001";
export const guarantorPhone = "+233241000002";
export const applicationId = "10000000-0000-4000-8000-000000000001";
export const vehicleModelId = "20000000-0000-4000-8000-000000000001";
export const contractId = "60000000-0000-4000-8000-000000000001";
export const applicantPersonId = "70000000-0000-4000-8000-000000000001";
export const guarantorPersonId = "70000000-0000-4000-8000-000000000002";
export const invitationToken = "invitation-token-for-controlled-pilot";
export const otpCode = "619204";

const paymentSecret = "controlled-pilot-payment-signing-secret";
const stages = [
  ["VERIFICATION", "VERIFICATION_OFFICER", "BSM_INITIAL_REVIEW"],
  ["BSM_INITIAL", "BSM", "AGM_REVIEW"],
  ["AGM", "AGM", "CFO_REVIEW"],
  ["CFO", "CFO", "BSM_FINAL_REVIEW"],
  ["BSM_FINAL", "BSM", "MD_REVIEW"],
  ["MD", "MD", "APPROVED"],
] as const;

type Stage = (typeof stages)[number][0];
type Role =
  | "VERIFICATION_OFFICER"
  | "BSM"
  | "AGM"
  | "CFO"
  | "MD"
  | "FINANCE_OFFICER"
  | "INVENTORY_OFFICER"
  | "OPERATIONS_OFFICER"
  | "RECOVERY_OFFICER"
  | "CUSTOMER_SUPPORT";

export interface PilotLedgerEntry {
  id: string;
  eventId: string;
  providerTransactionId: string;
  kind: "DEPOSIT" | "REPAYMENT";
  amountMinorUnits: string;
  receiptId: string | null;
}

export interface PilotState {
  application: {
    id: string;
    status: string;
    version: number;
    currentStage: Stage;
  };
  identities: Record<string, { consentId: string | null; verified: boolean }>;
  documents: Record<string, { id: string; status: "PENDING" | "ACCEPTED" }>;
  offer: {
    id: string;
    version: number;
    status: "DRAFT" | "ACCEPTED";
    depositMinor: string;
    principalMinor: string;
  } | null;
  ledger: PilotLedgerEntry[];
  receipts: Record<string, { id: string; amountMinorUnits: string }>;
  reconciliation: Array<{ id: string; eventId: string; reason: string }>;
  asset: { id: string; vin: string; version: number } | null;
  assignment: { id: string; depositEvidenceId: string } | null;
  contract: {
    id: string;
    status: "DRAFT" | "EXECUTED" | "ACTIVE" | "SETTLED";
    version: number;
    ownershipHolder: "SOMOCO" | "CUSTOMER";
    outstandingBalanceMinor: string;
    handoverAcknowledged: boolean;
  } | null;
  arrears: {
    consecutiveMissed: number;
    totalUnpaid: number;
    signals: string[];
  };
  recoveryCases: Array<{ id: string; approved: boolean }>;
  settlement: {
    financeApproved: boolean;
    businessApproved: boolean;
    evidenceId: string | null;
    settled: boolean;
    transferred: boolean;
  };
  provider: { niaOutage: boolean; sapSyncEnabled: false };
  otpRequests: Record<string, number>;
  otpFailures: Record<string, number>;
}

export interface PilotHarness {
  readonly baseUrl: string;
  readonly applicantToken: string;
  readonly guarantorToken: string;
  readonly staffTokens: Readonly<Record<Role, string>>;
  readonly state: PilotState;
  close(): Promise<void>;
  setNiaOutage(value: boolean): void;
  setArrears(input: { consecutiveMissed: number; totalUnpaid: number }): void;
  seedActiveContract(outstandingBalanceMinor?: string): void;
  signPayment(body: Record<string, unknown>): {
    body: string;
    headers: { "x-payment-signature": string; "x-payment-timestamp": string };
  };
}

export async function startPilotHarness(): Promise<PilotHarness> {
  const state: PilotState = {
    application: {
      id: applicationId,
      status: "DRAFT",
      version: 1,
      currentStage: "VERIFICATION",
    },
    identities: {
      [applicantPhone]: { consentId: null, verified: false },
      [guarantorPhone]: { consentId: null, verified: false },
    },
    documents: {},
    offer: null,
    ledger: [],
    receipts: {},
    reconciliation: [],
    asset: null,
    assignment: null,
    contract: null,
    arrears: { consecutiveMissed: 0, totalUnpaid: 0, signals: [] },
    recoveryCases: [],
    settlement: {
      financeApproved: false,
      businessApproved: false,
      evidenceId: null,
      settled: false,
      transferred: false,
    },
    provider: { niaOutage: false, sapSyncEnabled: false },
    otpRequests: {},
    otpFailures: {},
  };

  const applicantToken = "customer-session-applicant";
  const guarantorToken = "customer-session-guarantor";
  const staffTokens = Object.fromEntries(
    [
      "VERIFICATION_OFFICER",
      "BSM",
      "AGM",
      "CFO",
      "MD",
      "FINANCE_OFFICER",
      "INVENTORY_OFFICER",
      "OPERATIONS_OFFICER",
      "RECOVERY_OFFICER",
      "CUSTOMER_SUPPORT",
    ].map((role) => [role, `staff-session-${role.toLowerCase()}`]),
  ) as Record<Role, string>;

  const server = createServer((request, response) => {
    void handleRequest(request, response, state, {
      applicantToken,
      guarantorToken,
      staffTokens,
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("PILOT_SERVER_ADDRESS");
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    applicantToken,
    guarantorToken,
    staffTokens,
    state,
    close: () => closeServer(server),
    setNiaOutage(value) {
      state.provider.niaOutage = value;
    },
    setArrears(input) {
      state.arrears = {
        consecutiveMissed: input.consecutiveMissed,
        totalUnpaid: input.totalUnpaid,
        signals: [
          ...(input.consecutiveMissed >= 3 ? ["THREE_CONSECUTIVE_MISSED"] : []),
          ...(input.totalUnpaid >= 3 ? ["THREE_TOTAL_UNPAID"] : []),
        ],
      };
    },
    seedActiveContract(outstandingBalanceMinor = "30000") {
      state.contract = {
        id: contractId,
        status: "ACTIVE",
        version: 1,
        ownershipHolder: "SOMOCO",
        outstandingBalanceMinor,
        handoverAcknowledged: true,
      };
      state.application.status = "ACTIVE";
    },
    signPayment(body) {
      const serialized = JSON.stringify(body);
      const timestamp = "2026-08-23T12:00:00.000Z";
      const signature = createHmac("sha256", paymentSecret)
        .update(`${timestamp}.${serialized}`)
        .digest("hex");
      return {
        body: serialized,
        headers: {
          "x-payment-signature": `sha256=${signature}`,
          "x-payment-timestamp": timestamp,
        },
      };
    },
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: PilotState,
  tokens: {
    applicantToken: string;
    guarantorToken: string;
    staffTokens: Readonly<Record<Role, string>>;
  },
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://pilot.test");
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response);
      return;
    }
    const input = await readJson(request);
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (method === "GET" && path === "/health/live") {
      send(response, 200, { status: "ok", simulator: true });
      return;
    }
    if (method === "GET" && path === "/health/ready") {
      send(response, 200, { status: "ok", database: "DISPOSABLE_SYNTHETIC" });
      return;
    }
    if (method === "POST" && path === "/v1/customer/otp/requests") {
      otpRequest(response, state, input);
      return;
    }
    if (method === "POST" && path === "/v1/customer/otp/verifications") {
      otpVerification(response, state, input, tokens);
      return;
    }
    if (method === "POST" && path === "/v1/integrations/payments/somoco") {
      paymentWebhook(request, response, state, input);
      return;
    }
    if (method === "POST" && path === "/v1/integrations/sap/sync") {
      fail(
        response,
        503,
        "SAP_SYNC_DISABLED",
        "SAP synchronization remains off pending discovery.",
      );
      return;
    }

    const token = bearer(request);
    if (
      path.startsWith("/v1/customer/") &&
      token !== tokens.applicantToken &&
      token !== tokens.guarantorToken
    ) {
      fail(
        response,
        401,
        "CUSTOMER_SESSION_REQUIRED",
        "A customer session is required.",
      );
      return;
    }
    const customer = customerPhone(request, tokens);
    if (method === "POST" && path === "/v1/customer/consents") {
      requirePhone(input.phoneE164, customer);
      if (state.provider.niaOutage) {
        fail(
          response,
          503,
          "NIA_UNAVAILABLE",
          "The NIA simulator is unavailable.",
        );
        return;
      }
      const consentId = deterministicConsent(customer);
      state.identities[customer]!.consentId = consentId;
      send(response, 201, { consentId });
      return;
    }
    if (
      method === "POST" &&
      path === "/v1/customer/identity/ghana-card-verifications"
    ) {
      const identity = state.identities[customer]!;
      if (state.provider.niaOutage) {
        fail(
          response,
          503,
          "NIA_UNAVAILABLE",
          "The NIA simulator is unavailable.",
        );
        return;
      }
      if (input.consentId !== identity.consentId) {
        fail(
          response,
          409,
          "CONSENT_REQUIRED",
          "An identity consent is required.",
        );
        return;
      }
      identity.verified = true;
      send(response, 201, {
        status: "VERIFIED",
        providerReference: `nia-${customer}`,
      });
      return;
    }
    if (method === "POST" && path === "/v1/customer/documents/uploads") {
      if (!state.identities[customer]!.verified) {
        fail(
          response,
          409,
          "NIA_REQUIRED",
          "Identity verification is required.",
        );
        return;
      }
      if (
        String(input.mimeType).includes("x-msdownload") ||
        input.malware === true
      ) {
        fail(
          response,
          422,
          "MALWARE_REJECTED",
          "The document was quarantined by malware scanning.",
        );
        return;
      }
      const documentId = deterministicDocument(customer);
      state.documents[customer] = { id: documentId, status: "PENDING" };
      send(response, 201, {
        documentId,
        uploadUrl: `${baseObjectUrl()}/${documentId}`,
        expiresAt: "2026-08-23T12:10:00.000Z",
        requiredHeaders: { "content-type": input.mimeType ?? "image/jpeg" },
      });
      return;
    }
    if (
      method === "POST" &&
      /^\/v1\/customer\/documents\/[^/]+\/complete$/.test(path)
    ) {
      const document = state.documents[customer];
      if (document === undefined || path.split("/").at(-2) !== document.id) {
        fail(
          response,
          404,
          "DOCUMENT_NOT_FOUND",
          "The document was not found.",
        );
        return;
      }
      document.status = "ACCEPTED";
      send(response, 200, {
        documentId: document.id,
        status: "ACCEPTED",
        sha256: "a".repeat(64),
      });
      return;
    }
    if (method === "GET" && path === "/v1/customer/vehicle-models") {
      send(response, 200, [
        {
          id: vehicleModelId,
          manufacturer: "Synthetic Motors",
          modelName: "Pilot Bike",
          modelYear: 2026,
        },
      ]);
      return;
    }
    if (method === "POST" && path === "/v1/customer/applications") {
      requireApplicant(customer);
      send(response, 201, applicationDto(state));
      return;
    }
    if (method === "GET" && path === "/v1/customer/applications/resume") {
      send(response, 200, {
        draft: applicationDto(state),
        guarantorStatus: state.identities[guarantorPhone]!.verified
          ? "CONFIRMED"
          : "NOT_INVITED",
        guarantorInvitation: {
          status: "INVITED",
          relationshipVersion: 1,
          expiresAt: "2026-08-23T13:00:00.000Z",
        },
      });
      return;
    }
    const applicantMatch = path.match(
      /^\/v1\/customer\/applications\/([^/]+)\/applicant$/,
    );
    if (method === "PATCH" && applicantMatch !== null) {
      requireApplicant(customer);
      requireVersion(state, input.expectedVersion);
      if (
        !state.identities[customer]!.verified ||
        state.documents[customer]?.status !== "ACCEPTED"
      ) {
        fail(
          response,
          409,
          "APPLICANT_INCOMPLETE",
          "Applicant identity and clean documents are required.",
        );
        return;
      }
      state.application.version += 1;
      state.application.status = "DRAFT";
      send(response, 200, applicationDto(state));
      return;
    }
    if (
      method === "POST" &&
      path ===
        `/v1/customer/applications/${applicationId}/guarantor-invitations`
    ) {
      requireApplicant(customer);
      requireVersion(state, input.expectedVersion);
      state.application.version += 1;
      state.application.status = "AWAITING_GUARANTOR";
      send(response, 201, {
        invitationId: "50000000-0000-4000-8000-000000000001",
        applicationVersion: state.application.version,
        relationshipVersion: 1,
        expiresAt: "2026-08-23T13:00:00.000Z",
      });
      return;
    }
    if (
      method === "POST" &&
      path === "/v1/customer/guarantor-invitations/resolutions"
    ) {
      requireGuarantor(customer);
      requireInvitation(input.invitationToken);
      send(response, 200, {
        status: "INVITED",
        relationshipVersion: 1,
        applicationVersion: state.application.version,
        expiresAt: "2026-08-23T13:00:00.000Z",
      });
      return;
    }
    if (method === "PATCH" && path === "/v1/customer/guarantor") {
      requireGuarantor(customer);
      requireInvitation(input.invitationToken);
      requireVersion(state, input.expectedVersion);
      if (
        !state.identities[customer]!.verified ||
        state.documents[customer]?.status !== "ACCEPTED"
      ) {
        fail(
          response,
          409,
          "GUARANTOR_INCOMPLETE",
          "Guarantor identity and clean documents are required.",
        );
        return;
      }
      state.application.version += 1;
      state.application.status = "READY_TO_SUBMIT";
      send(response, 200, {
        relationshipVersion: 2,
        applicationVersion: state.application.version,
        status: "CONFIRMED",
      });
      return;
    }
    const applicationPath = path.match(
      /^\/v1\/customer\/applications\/([^/]+)\/submissions$/,
    );
    if (method === "POST" && applicationPath !== null) {
      requireApplicant(customer);
      requireVersion(state, input.expectedVersion);
      if (
        !state.identities[guarantorPhone]!.verified ||
        state.documents[guarantorPhone]?.status !== "ACCEPTED"
      ) {
        fail(
          response,
          409,
          "GUARANTOR_INCOMPLETE",
          "Guarantor evidence is required.",
        );
        return;
      }
      state.application.version += 1;
      state.application.status = "VERIFICATION_REVIEW";
      state.application.currentStage = "VERIFICATION";
      send(response, 200, applicationDto(state));
      return;
    }
    const resubmitPath = path.match(
      /^\/v1\/customer\/applications\/([^/]+)\/resubmissions$/,
    );
    if (method === "POST" && resubmitPath !== null) {
      requireApplicant(customer);
      if (state.application.status !== "INFORMATION_REQUESTED") {
        fail(
          response,
          409,
          "RESUBMISSION_NOT_ALLOWED",
          "Information has not been requested.",
        );
        return;
      }
      state.application.version += 1;
      state.application.status = stageStatus(state.application.currentStage);
      send(response, 200, applicationDto(state));
      return;
    }
    const offerPath = path.match(
      /^\/v1\/customer\/applications\/([^/]+)\/offers$/,
    );
    if (method === "POST" && offerPath !== null) {
      requireApplicant(customer);
      if (state.application.status !== "APPROVED") {
        fail(
          response,
          409,
          "OFFER_NOT_ALLOWED",
          "An offer requires MD approval.",
        );
        return;
      }
      if (input.tenureMonths !== 12) {
        fail(
          response,
          409,
          "TENURE_NOT_LICENSED",
          "Only licence-evidenced tenures are enabled.",
        );
        return;
      }
      state.offer = {
        id: "80000000-0000-4000-8000-000000000001",
        version: 1,
        status: "DRAFT",
        depositMinor: String(input.depositMinor),
        principalMinor: "30000",
      };
      send(response, 201, offerDto(state));
      return;
    }
    const acceptPath = path.match(/^\/v1\/customer\/offers\/([^/]+)\/accept$/);
    if (method === "POST" && acceptPath !== null) {
      requireApplicant(customer);
      if (state.offer === null || state.offer.id !== acceptPath[1]) {
        fail(response, 404, "OFFER_NOT_FOUND", "The offer was not found.");
        return;
      }
      state.offer.status = "ACCEPTED";
      state.application.status = "AWAITING_DEPOSIT";
      state.application.version += 1;
      send(response, 200, offerDto(state));
      return;
    }
    if (method === "GET" && path === "/v1/customer/payments") {
      send(
        response,
        200,
        state.ledger.map((entry) => ({
          id: entry.id,
          amountMinorUnits: entry.amountMinorUnits,
          receiptId: entry.receiptId,
        })),
      );
      return;
    }
    if (method === "GET" && path === "/v1/customer/receipts") {
      send(response, 200, Object.values(state.receipts));
      return;
    }
    if (method === "GET" && path === "/v1/customer/payment-instructions") {
      send(response, 200, {
        channel: "USSD_MOBILE_MONEY",
        ussdInstructions: "Dial *800*BNPL#",
        cashAccepted: false,
      });
      return;
    }
    if (method === "GET" && path === "/v1/customer/account-status") {
      send(response, 200, [
        {
          contractId,
          contractStatus: state.contract?.status ?? "NOT_ACTIVE",
          outstandingBalanceMinorUnits:
            state.contract?.outstandingBalanceMinor ?? "0",
          consecutiveMissedPayments: state.arrears.consecutiveMissed,
          totalUnpaidPayments: state.arrears.totalUnpaid,
          signals: state.arrears.signals,
          cashAccepted: false,
        },
      ]);
      return;
    }
    const customerAcknowledgementPath = path.match(
      /^\/v1\/customer\/contracts\/([^/]+)\/handover-acknowledgement$/,
    );
    if (method === "POST" && customerAcknowledgementPath !== null) {
      requireApplicant(customer);
      requireContract(state);
      state.contract.handoverAcknowledged = true;
      send(response, 201, { contractId, acknowledged: true });
      return;
    }

    const staffRole = staffRoleFromToken(request, tokens.staffTokens);
    if (staffRole === null) {
      fail(
        response,
        401,
        "STAFF_SESSION_REQUIRED",
        "A staff session is required.",
      );
      return;
    }
    if (method === "GET" && path === "/v1/staff/applications/queue") {
      send(
        response,
        200,
        state.application.status.endsWith("REVIEW") ||
          state.application.status === "INFORMATION_REQUESTED"
          ? [
              {
                id: applicationId,
                status: state.application.status,
                version: state.application.version,
              },
            ]
          : [],
      );
      return;
    }
    const staffApplication = path.match(/^\/v1\/staff\/applications\/([^/]+)$/);
    if (method === "GET" && staffApplication !== null) {
      send(response, 200, applicationDto(state));
      return;
    }
    const decisionPath = path.match(
      /^\/v1\/staff\/applications\/([^/]+)\/(approve|request-information|reject)$/,
    );
    if (method === "POST" && decisionPath !== null) {
      const stage = String(input.stage) as Stage;
      const expected = stages.find((item) => item[0] === stage);
      if (expected === undefined || state.application.currentStage !== stage) {
        fail(
          response,
          409,
          "APPROVAL_STAGE_CONFLICT",
          "The approval stage is not current.",
        );
        return;
      }
      if (staffRole !== expected[1]) {
        fail(
          response,
          403,
          "WRONG_ROLE",
          "The authenticated role cannot approve this stage.",
        );
        return;
      }
      requireVersion(state, input.expectedVersion);
      state.application.version += 1;
      if (decisionPath[2] === "request-information")
        state.application.status = "INFORMATION_REQUESTED";
      else if (decisionPath[2] === "reject")
        state.application.status = "REJECTED";
      else {
        state.application.status = expected[2];
        if (expected[2] === "APPROVED") state.application.currentStage = "MD";
        else
          state.application.currentStage =
            stages[stages.findIndex((item) => item[0] === stage) + 1]![0];
      }
      send(response, 200, {
        status: state.application.status,
        version: state.application.version,
        stage,
      });
      return;
    }
    if (method === "POST" && /^\/v1\/staff\/assets$/.test(path)) {
      requireRole(staffRole, "INVENTORY_OFFICER");
      state.asset = {
        id: "90000000-0000-4000-8000-000000000001",
        vin: String(input.vin),
        version: 1,
      };
      send(response, 201, {
        id: state.asset.id,
        vehicleModelId,
        vin: state.asset.vin,
        chassisNumber: input.chassisNumber,
        status: "AVAILABLE",
        version: 1,
      });
      return;
    }
    const assignmentPath = path.match(
      /^\/v1\/staff\/applications\/([^/]+)\/asset-assignment$/,
    );
    if (method === "POST" && assignmentPath !== null) {
      requireRole(staffRole, "INVENTORY_OFFICER");
      if (
        state.application.status !== "AWAITING_ASSET_ASSIGNMENT" ||
        state.offer?.status !== "ACCEPTED" ||
        state.ledger.every((item) => item.kind !== "DEPOSIT")
      ) {
        fail(
          response,
          409,
          "DEPOSIT_RECONCILIATION_REQUIRED",
          "A reconciled deposit is required before VIN assignment.",
        );
        return;
      }
      if (state.asset === null) {
        fail(response, 409, "ASSET_REQUIRED", "A vehicle unit is required.");
        return;
      }
      state.assignment = {
        id: "91000000-0000-4000-8000-000000000001",
        depositEvidenceId: state.ledger.find((item) => item.kind === "DEPOSIT")!
          .id,
      };
      state.application.status = "AWAITING_EXECUTION";
      send(response, 200, {
        id: state.assignment.id,
        applicationId,
        vehicleUnitId: state.asset.id,
        offerId: state.offer.id,
        offerVersionId: "offer-version-1",
        depositReconciledAmountMinor: "10000",
        depositEvidenceId: state.assignment.depositEvidenceId,
        assignedAt: "2026-08-23T12:00:00.000Z",
        version: 1,
      });
      return;
    }
    const contractGenerate = path.match(
      /^\/v1\/staff\/applications\/([^/]+)\/contracts$/,
    );
    if (method === "POST" && contractGenerate !== null) {
      requireRole(staffRole, "OPERATIONS_OFFICER");
      if (state.assignment === null) {
        fail(
          response,
          409,
          "ASSIGNMENT_REQUIRED",
          "Vehicle assignment is required.",
        );
        return;
      }
      state.contract = {
        id: contractId,
        status: "DRAFT",
        version: 1,
        ownershipHolder: "SOMOCO",
        outstandingBalanceMinor: "30000",
        handoverAcknowledged: false,
      };
      send(response, 201, contractDto(state));
      return;
    }
    const executionPath = path.match(
      /^\/v1\/staff\/contracts\/([^/]+)\/execution$/,
    );
    if (method === "POST" && executionPath !== null) {
      requireRole(staffRole, "OPERATIONS_OFFICER");
      requireContract(state);
      requireVersion(state, input.expectedVersion, state.contract!.version);
      state.contract!.version += 1;
      state.contract!.status = "EXECUTED";
      send(response, 200, contractDto(state));
      return;
    }
    const acknowledgementPath = path.match(
      /^\/v1\/customer\/contracts\/([^/]+)\/handover-acknowledgement$/,
    );
    if (method === "POST" && acknowledgementPath !== null) {
      requireApplicant(customer);
      requireContract(state);
      state.contract.handoverAcknowledged = true;
      send(response, 201, { contractId, acknowledged: true });
      return;
    }
    const handoverPath = path.match(
      /^\/v1\/staff\/contracts\/([^/]+)\/handover$/,
    );
    if (method === "POST" && handoverPath !== null) {
      requireRole(staffRole, "OPERATIONS_OFFICER");
      requireContract(state);
      if (!state.contract.handoverAcknowledged) {
        fail(
          response,
          409,
          "CUSTOMER_HANDOVER_ACK_REQUIRED",
          "Customer handover acknowledgement is required.",
        );
        return;
      }
      state.contract.version += 1;
      send(response, 200, { ...contractDto(state), handoverComplete: true });
      return;
    }
    const activatePath = path.match(
      /^\/v1\/staff\/contracts\/([^/]+)\/activate$/,
    );
    if (method === "POST" && activatePath !== null) {
      requireRole(staffRole, "OPERATIONS_OFFICER");
      requireContract(state);
      state.contract.version += 1;
      state.contract.status = "ACTIVE";
      state.application.status = "ACTIVE";
      send(response, 200, contractDto(state));
      return;
    }
    if (method === "GET" && path === "/v1/staff/assets") {
      requireRole(staffRole, "INVENTORY_OFFICER");
      send(
        response,
        200,
        state.asset === null
          ? []
          : [
              {
                id: state.asset.id,
                vin: state.asset.vin,
                version: state.asset.version,
                status: "ASSIGNED",
              },
            ],
      );
      return;
    }
    const trackerPath = path.match(/^\/v1\/staff\/assets\/([^/]+)\/tracker$/);
    if (trackerPath !== null && method === "GET") {
      requireRole(staffRole, "RECOVERY_OFFICER");
      if (state.recoveryCases.every((item) => !item.approved)) {
        fail(
          response,
          409,
          "RECOVERY_AUTHORIZATION_REQUIRED",
          "An approved recovery case is required.",
        );
        return;
      }
      send(response, 200, {
        locationOnly: true,
        latitude: "5.6037",
        longitude: "-0.1870",
        recordedAt: "2026-08-23T11:00:00.000Z",
      });
      return;
    }
    if (method === "GET" && path === "/v1/staff/collections/arrears") {
      requireCollectionRole(staffRole);
      send(response, 200, [
        {
          contractId,
          consecutiveMissedInstallments: state.arrears.consecutiveMissed,
          unpaidInstallments: state.arrears.totalUnpaid,
          signals: state.arrears.signals,
        },
      ]);
      return;
    }
    if (method === "GET" && path === "/v1/staff/collections/cases") {
      requireCollectionRole(staffRole);
      send(response, 200, state.recoveryCases);
      return;
    }
    if (method === "POST" && path === "/v1/staff/collections/cases") {
      requireRole(staffRole, "RECOVERY_OFFICER");
      const id = "92000000-0000-4000-8000-000000000001";
      state.recoveryCases.push({ id, approved: false });
      send(response, 201, { id, status: "OPEN" });
      return;
    }
    const recoveryDecision = path.match(
      /^\/v1\/staff\/collections\/cases\/([^/]+)\/decision$/,
    );
    if (method === "POST" && recoveryDecision !== null) {
      requireRole(staffRole, "RECOVERY_OFFICER");
      const found = state.recoveryCases.find(
        (item) => item.id === recoveryDecision[1],
      );
      if (found === undefined) {
        fail(
          response,
          404,
          "RECOVERY_CASE_NOT_FOUND",
          "The recovery case was not found.",
        );
        return;
      }
      found.approved = input.decision === "APPROVED";
      send(response, 200, { id: found.id, approved: found.approved });
      return;
    }
    const recoveryAction = path.match(
      /^\/v1\/staff\/collections\/cases\/([^/]+)\/actions$/,
    );
    if (method === "POST" && recoveryAction !== null) {
      requireRole(staffRole, "RECOVERY_OFFICER");
      if (
        ![
          "MANUAL_RECOVERY",
          "VISIT",
          "PROMISE_TO_PAY",
          "SEIZURE_EVIDENCE",
        ].includes(String(input.actionType))
      ) {
        fail(
          response,
          400,
          "AUTOMATIC_RECOVERY_PROHIBITED",
          "Recovery remains a human admin decision.",
        );
        return;
      }
      send(response, 201, {
        id: randomUUID(),
        authorized: true,
        actionType: input.actionType,
      });
      return;
    }
    if (
      method === "POST" &&
      path ===
        "/v1/staff/contracts/" + contractId + "/settlement/finance-approval"
    ) {
      requireAnyRole(staffRole, ["CFO", "FINANCE_OFFICER"]);
      requireContract(state);
      if (
        state.contract.outstandingBalanceMinor !== "0" ||
        state.reconciliation.length > 0
      ) {
        fail(
          response,
          409,
          "SETTLEMENT_NOT_CLEAN",
          "Settlement requires zero balance and clean reconciliation.",
        );
        return;
      }
      state.settlement.financeApproved = true;
      send(response, 200, {
        approvalType: "FINANCE_RECONCILIATION",
        approved: true,
      });
      return;
    }
    if (
      method === "POST" &&
      path ===
        "/v1/staff/contracts/" + contractId + "/settlement/business-approval"
    ) {
      requireRole(staffRole, "MD");
      requireContract(state);
      if (
        state.contract.outstandingBalanceMinor !== "0" ||
        state.reconciliation.length > 0
      ) {
        fail(
          response,
          409,
          "SETTLEMENT_NOT_CLEAN",
          "Settlement requires zero balance and clean reconciliation.",
        );
        return;
      }
      state.settlement.businessApproved = true;
      send(response, 200, {
        approvalType: "BUSINESS_OWNERSHIP_TRANSFER",
        approved: true,
      });
      return;
    }
    if (
      method === "POST" &&
      path === "/v1/staff/contracts/" + contractId + "/settlement/evidence"
    ) {
      requireAnyRole(staffRole, ["MD", "INVENTORY_OFFICER"]);
      state.settlement.evidenceId = String(input.evidenceDocumentId);
      send(response, 200, {
        verificationStatus: "CLEAN",
        evidenceDocumentId: state.settlement.evidenceId,
      });
      return;
    }
    if (
      method === "POST" &&
      path === "/v1/staff/contracts/" + contractId + "/settlement/commit"
    ) {
      requireAnyRole(staffRole, ["CFO", "MD"]);
      requireContract(state);
      if (
        !state.settlement.financeApproved ||
        !state.settlement.businessApproved ||
        state.settlement.evidenceId === null ||
        state.contract.outstandingBalanceMinor !== "0" ||
        state.reconciliation.length > 0
      ) {
        fail(
          response,
          409,
          "SETTLEMENT_NOT_READY",
          "All settlement gates must be clean and dual-approved.",
        );
        return;
      }
      state.settlement.settled = true;
      state.contract.status = "SETTLED";
      state.application.status = "SETTLED";
      send(response, 200, {
        settled: true,
        ownershipHolder: state.contract.ownershipHolder,
      });
      return;
    }
    if (
      method === "POST" &&
      path === "/v1/staff/contracts/" + contractId + "/ownership-transfer"
    ) {
      requireRole(staffRole, "MD");
      requireContract(state);
      if (
        !state.settlement.settled ||
        state.contract.outstandingBalanceMinor !== "0"
      ) {
        fail(
          response,
          409,
          "OWNERSHIP_TRANSFER_NOT_ALLOWED",
          "Ownership cannot transfer with an outstanding balance or unclean settlement.",
        );
        return;
      }
      state.settlement.transferred = true;
      state.contract.ownershipHolder = "CUSTOMER";
      send(response, 200, { transferred: true, ownershipHolder: "CUSTOMER" });
      return;
    }
    fail(
      response,
      404,
      "NOT_FOUND",
      `Unsupported pilot boundary ${method} ${path}`,
    );
  } catch (error) {
    if (error instanceof PilotHttpError) {
      fail(response, error.status, error.code, error.message);
      return;
    }
    fail(
      response,
      500,
      "PILOT_FIXTURE_FAILURE",
      error instanceof Error ? error.message : "Fixture failure.",
    );
  }
}

function otpRequest(
  response: ServerResponse,
  state: PilotState,
  input: Record<string, unknown>,
): void {
  const phone = String(input.phoneE164 ?? "");
  const count = (state.otpRequests[phone] ?? 0) + 1;
  state.otpRequests[phone] = count;
  if (count > 3) {
    fail(response, 429, "OTP_RATE_LIMITED", "Too many OTP requests.");
    return;
  }
  send(response, 202, { accepted: true });
}

function otpVerification(
  response: ServerResponse,
  state: PilotState,
  input: Record<string, unknown>,
  tokens: { applicantToken: string; guarantorToken: string },
): void {
  const phone = String(input.phoneE164 ?? "");
  if (![applicantPhone, guarantorPhone].includes(phone)) {
    fail(response, 401, "OTP_INVALID", "The OTP is invalid.");
    return;
  }
  if (input.code !== otpCode) {
    const failures = (state.otpFailures[phone] ?? 0) + 1;
    state.otpFailures[phone] = failures;
    fail(
      response,
      failures >= 3 ? 429 : 401,
      failures >= 3 ? "OTP_LOCKED" : "OTP_INVALID",
      "The OTP is invalid.",
    );
    return;
  }
  send(response, 201, {
    sessionToken:
      phone === applicantPhone ? tokens.applicantToken : tokens.guarantorToken,
    expiresAt: "2026-08-23T13:00:00.000Z",
  });
}

function paymentWebhook(
  request: IncomingMessage,
  response: ServerResponse,
  state: PilotState,
  input: Record<string, unknown>,
): void {
  const signature = request.headers["x-payment-signature"];
  const timestamp = request.headers["x-payment-timestamp"];
  if (typeof signature !== "string" || typeof timestamp !== "string") {
    fail(
      response,
      400,
      "PAYMENT_HEADERS_REQUIRED",
      "Signed payment headers are required.",
    );
    return;
  }
  const serialized = JSON.stringify(input);
  const expected = `sha256=${createHmac("sha256", paymentSecret).update(`${timestamp}.${serialized}`).digest("hex")}`;
  if (signature !== expected) {
    fail(
      response,
      401,
      "PAYMENT_SIGNATURE_INVALID",
      "The payment signature is invalid.",
    );
    return;
  }
  const eventId = String(input.eventId ?? "");
  const transactionId = String(input.providerTransactionId ?? "");
  const replay = state.ledger.find(
    (entry) =>
      entry.eventId === eventId ||
      entry.providerTransactionId === transactionId,
  );
  if (replay !== undefined) {
    send(response, 202, {
      status: "ACCEPTED",
      replay: true,
      ledgerEntryId: replay.id,
      receiptId: replay.receiptId,
    });
    return;
  }
  const unmatchedReplay = state.reconciliation.find(
    (item) => item.eventId === eventId,
  );
  if (unmatchedReplay !== undefined) {
    send(response, 202, {
      status: "UNMATCHED",
      replay: true,
      reconciliationCaseId: unmatchedReplay.id,
    });
    return;
  }
  if (input.channel !== "USSD" && input.channel !== "MOBILE_MONEY") {
    fail(
      response,
      422,
      "CASH_NOT_ACCEPTED",
      "Only USSD and Mobile Money are supported.",
    );
    return;
  }
  const reference = String(input.customerReference ?? "");
  if (reference !== applicationId && reference !== contractId) {
    const id = "93000000-0000-4000-8000-000000000001";
    state.reconciliation.push({
      id,
      eventId,
      reason: "UNMATCHED_CUSTOMER_REFERENCE",
    });
    send(response, 202, {
      status: "UNMATCHED",
      replay: false,
      reconciliationCaseId: id,
    });
    return;
  }
  const amount = String(
    (input.amount as Record<string, unknown> | undefined)?.minorUnits ?? "0",
  );
  const kind =
    state.offer !== null &&
    state.ledger.every((entry) => entry.kind !== "DEPOSIT")
      ? "DEPOSIT"
      : "REPAYMENT";
  const receiptId = `94000000-0000-4000-8000-${kind === "DEPOSIT" ? "000000000001" : String(Object.keys(state.receipts).length + 1).padStart(12, "0")}`;
  const entry: PilotLedgerEntry = {
    id: randomUUID(),
    eventId,
    providerTransactionId: transactionId,
    kind,
    amountMinorUnits: amount,
    receiptId,
  };
  state.ledger.push(entry);
  state.receipts[receiptId] = { id: receiptId, amountMinorUnits: amount };
  if (kind === "DEPOSIT")
    state.application.status = "AWAITING_ASSET_ASSIGNMENT";
  else if (state.contract !== null)
    state.contract.outstandingBalanceMinor = "0";
  send(response, 202, {
    status: "ACCEPTED",
    replay: false,
    ledgerEntryId: entry.id,
    receiptId,
  });
}

function customerPhone(
  request: IncomingMessage,
  tokens: { applicantToken: string; guarantorToken: string },
): string {
  const token = bearer(request);
  if (token === tokens.applicantToken) return applicantPhone;
  if (token === tokens.guarantorToken) return guarantorPhone;
  return "";
}

function staffRoleFromToken(
  request: IncomingMessage,
  tokens: Readonly<Record<Role, string>>,
): Role | null {
  const token = bearer(request);
  for (const [role, value] of Object.entries(tokens) as [Role, string][])
    if (token === value) return role;
  return null;
}

function bearer(request: IncomingMessage): string | null {
  const value = request.headers.authorization;
  return typeof value === "string" && /^Bearer\s+/.test(value)
    ? value.replace(/^Bearer\s+/, "")
    : null;
}

function requireApplicant(phone: string): void {
  if (phone !== applicantPhone)
    throw new PilotHttpError(
      403,
      "APPLICATION_FORBIDDEN",
      "Applicant access is required.",
    );
}

function requireGuarantor(phone: string): void {
  if (phone !== guarantorPhone)
    throw new PilotHttpError(
      403,
      "GUARANTOR_FORBIDDEN",
      "Guarantor access is required.",
    );
}

function requirePhone(expected: unknown, actual: string): void {
  if (expected !== actual)
    throw new PilotHttpError(
      403,
      "PHONE_MISMATCH",
      "The authenticated phone does not match.",
    );
}

function requireInvitation(value: unknown): void {
  if (value !== invitationToken)
    throw new PilotHttpError(
      404,
      "INVITATION_NOT_FOUND",
      "The invitation was not found.",
    );
}

function requireVersion(
  state: PilotState,
  value: unknown,
  actual = state.application.version,
): void {
  if (value !== actual)
    throw new PilotHttpError(
      409,
      "VERSION_CONFLICT",
      "The resource version is stale.",
    );
}

function requireContract(state: PilotState): asserts state is PilotState & {
  contract: NonNullable<PilotState["contract"]>;
} {
  if (state.contract === null)
    throw new PilotHttpError(
      404,
      "CONTRACT_NOT_FOUND",
      "The contract was not found.",
    );
}

function requireRole(actual: Role, expected: Role): void {
  if (actual !== expected)
    throw new PilotHttpError(403, "FORBIDDEN", `Role ${expected} is required.`);
}

function requireAnyRole(actual: Role, expected: readonly Role[]): void {
  if (!expected.includes(actual))
    throw new PilotHttpError(403, "FORBIDDEN", "The role is not authorized.");
}

function requireCollectionRole(actual: Role): void {
  requireAnyRole(actual, [
    "RECOVERY_OFFICER",
    "BSM",
    "AGM",
    "CFO",
    "MD",
    "CUSTOMER_SUPPORT",
  ]);
}

function applicationDto(state: PilotState): Record<string, unknown> {
  return {
    id: state.application.id,
    status: state.application.status,
    version: state.application.version,
    currentStage: state.application.currentStage,
    applicantPersonId,
    guarantorPersonId,
    vehicleModelId,
  };
}

function offerDto(state: PilotState): Record<string, unknown> {
  if (state.offer === null) return {};
  return {
    id: state.offer.id,
    status: state.offer.status,
    version: state.offer.version,
    depositMinor: state.offer.depositMinor,
    principalMinor: state.offer.principalMinor,
    disclosedVersion: "disclosure-v1",
    disclosedHash: "b".repeat(64),
  };
}

function contractDto(state: PilotState): Record<string, unknown> {
  if (state.contract === null) return {};
  return {
    id: state.contract.id,
    reference: "CONTRACT-PILOT-001",
    applicationId,
    status: state.contract.status,
    version: state.contract.version,
    canonicalHash: "c".repeat(64),
    previewReference: "preview://contract-pilot-001",
    ownershipHolder: state.contract.ownershipHolder,
    outstandingBalanceMinor: state.contract.outstandingBalanceMinor,
    generatedAt: "2026-08-23T12:00:00.000Z",
    activatedAt:
      state.contract.status === "ACTIVE" || state.contract.status === "SETTLED"
        ? "2026-08-23T12:00:00.000Z"
        : null,
  };
}

function stageStatus(stage: Stage): string {
  return (
    {
      VERIFICATION: "VERIFICATION_REVIEW",
      BSM_INITIAL: "BSM_INITIAL_REVIEW",
      AGM: "AGM_REVIEW",
      CFO: "CFO_REVIEW",
      BSM_FINAL: "BSM_FINAL_REVIEW",
      MD: "MD_REVIEW",
    } as const
  )[stage];
}

function deterministicConsent(phone: string): string {
  return phone === applicantPhone
    ? "30000000-0000-4000-8000-000000000001"
    : "30000000-0000-4000-8000-000000000002";
}

function deterministicDocument(phone: string): string {
  return phone === applicantPhone
    ? "40000000-0000-4000-8000-000000000001"
    : "40000000-0000-4000-8000-000000000002";
}

function baseObjectUrl(): string {
  return "http://objects.controlled-pilot.invalid";
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        );
        resolve(
          typeof parsed === "object" &&
            parsed !== null &&
            !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

function sendHtml(response: ServerResponse): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(
    `<!doctype html><title>Controlled pilot</title><main><h1>Applicant pilot portal</h1><form id="otp"><label>Mobile number <input name="phoneE164" value="${applicantPhone}" /></label><button>Send code</button></form><output id="otp-result"></output><script>document.querySelector('#otp').addEventListener('submit',async(e)=>{e.preventDefault();const r=await fetch('/v1/customer/otp/requests',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({phoneE164:document.querySelector('[name=phoneE164]').value})});document.querySelector('#otp-result').textContent=String(r.status);});</script></main>`,
  );
}

function send(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(payload));
}

function fail(
  response: ServerResponse,
  status: number,
  code: string,
  detail: string,
): void {
  send(response, status, { code, detail });
}

class PilotHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}
