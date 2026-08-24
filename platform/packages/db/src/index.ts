export {
  createDatabase,
  probeDatabase,
  type Database,
  type DatabaseConnection,
} from "./client.js";
export {
  currentOutboxCorrelationId,
  enterOutboxCorrelationId,
} from "./outbox-context.js";
export {
  completeInboxMessage,
  findInboxMessage,
  receiveInboxMessage,
  type InboxMessage,
  type InboxMessageInput,
  type InboxReceipt,
} from "./inbox.js";
export {
  claimOutboxBatch,
  completeOutboxAttempt,
  enqueueOutbox,
  exceptOutboxAttempt,
  heartbeatOutboxClaim,
  listOutboxAttempts,
  scheduleOutboxRetry,
  type ClaimOutboxBatchOptions,
  type ClaimedOutboxMessage,
  type CompleteOutboxAttemptInput,
  type FailOutboxAttemptInput,
  type HeartbeatOutboxClaimInput,
  type NewOutboxMessage,
  type OutboxAttemptRecord,
  type OutboxMessage,
} from "./outbox.js";
export {
  createStaffSession,
  createStaffSessionForAccessVersion,
  createStaffUser,
  createStaffUserInTransaction,
  findActiveStaffSessionByTokenHash,
  findStaffUserByEmail,
  findStaffUserById,
  revokeAllStaffSessions,
  revokeStaffSession,
  updateStaffUserAccess,
  type ActiveStaffSession,
  type DatabaseStaffRole,
  type DatabaseStaffUserStatus,
  type NewStaffSession,
  type NewStaffSessionForAccessVersion,
  type NewStaffUser,
  type StaffUserRecord,
  type UpdateStaffUserAccess,
} from "./repositories/access.js";
export {
  applicationRepo,
  type NewApplication,
} from "./repositories/applications.js";
export {
  approvalRepo,
  type DelegationRecord,
  type WorkflowCommandRecord,
} from "./repositories/approvals.js";
export {
  createApplicationDraft,
  createGuarantorInvitation,
  findGuarantorInvitationDeliveryContext,
  listActiveVehicleModels,
  readOwnedApplicationState,
  readResumableApplication,
  resolveGuarantorInvitation,
  saveApplicantSection,
  saveGuarantorSection,
  submitApplication,
  type ApplicationActor,
  type ApplicationState,
} from "./repositories/application-onboarding.js";
export {
  appendAuditEvent,
  listAuditEventsByActor,
  listAuditEventsByRequestId,
  type NewAuditEvent,
} from "./repositories/audit.js";
export {
  APPLICATION_SIGNATURE_PURPOSE,
  findApplicationSignatureEvidence,
  recordApplicationSignature,
  type ApplicationSignatureActor,
  type ApplicationSignatureEvidence,
  type ApplicationSignatureRecord,
  type RecordApplicationSignatureInput,
} from "./repositories/signatures.js";
export {
  financingRepo,
  type ApplicationGateRecord,
  type ExceptionRecord,
  type FinancingCommandRecord,
  type FinancingRuleRecord,
  type OfferRecord,
} from "./repositories/financing.js";
export {
  completeOwnershipTransfer,
  type CompleteOwnershipTransferCommand,
} from "./repositories/contracts.js";
export {
  assetContractRepo,
  type AssetContractCommandRecord,
  type AssignmentRow,
  type ApplicationRow as AssetApplicationRow,
  type ContractRow as AssetContractRow,
  type DepositRow,
  type ExecutionRow,
  type HandoverAcknowledgementRow,
  type HandoverRow,
  type OfferRow as AssetOfferRow,
  type ReassignmentApprovalRow,
  type TemplateRow,
  type VehicleRow,
} from "./repositories/asset-contracts.js";
export {
  createPendingDocument,
  findOwnedDocument,
  transitionDocumentStatus,
  type DocumentStatus,
} from "./repositories/documents.js";
export type { WriteEffects } from "./repositories/effects.js";
export {
  createCustomerSession,
  createConsentEvidence,
  claimIdentityCheck,
  completeIdentityCheck,
  createOtpChallenge,
  createOtpChallengeIfPersonExists,
  findActiveCustomerSessionByTokenHash,
  findOwnedConsentEvidence,
  findIdentityCheckByIdempotencyKey,
  findIdentityCheckById,
  findIdentityCheckByProviderReference,
  findLatestUsableOtpChallenge,
  findLatestOtpChallengeForCooldown,
  findOtpDeliveryContext,
  findOrCreateCustomerAccount,
  findPersonById,
  findPersonByPhone,
  invalidateOtpChallenge,
  lockIdentityProviderReference,
  lockOtpPhone,
  markOtpDeliveryFailed,
  invalidateOutstandingOtpChallenges,
  markDuplicateIdentityCheck,
  markIdentityCheckProviderReferenceConflict,
  lockPersonByPhone,
  recordFailedOtpAttempt,
  releaseIdentityCheckClaim,
  reserveIdentityCheck,
} from "./repositories/identity.js";
export { ledgerRepo, type NewLedgerEntry } from "./repositories/ledger.js";
export {
  collectionsRepo,
  type ArrearsInstallmentRow,
  type CollectionContractContext,
} from "./repositories/collections.js";
export {
  paymentRepo,
  type NewPaymentTransaction,
  type PaymentTransaction,
  type PaymentReceipt,
  type ReconciliationCase,
  type PaymentAdjustment,
  type PaymentAllocationPolicy,
  type PaymentSettlementBatch,
} from "./repositories/payments.js";
export {
  appendReportExportFailedEvent,
  appendReportExportReadyEvent,
  type FailReportExportInput,
  type CompleteReportExportInput,
} from "./repositories/reports.js";
export { withTransaction, type DatabaseTransaction } from "./transaction.js";
export { migrateDatabase } from "./schema/migration.js";
