export {
  createDatabase,
  type Database,
  type DatabaseConnection,
} from "./client.js";
export {
  completeInboxMessage,
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
  appendAuditEvent,
  listAuditEventsByActor,
  listAuditEventsByRequestId,
  type NewAuditEvent,
} from "./repositories/audit.js";
export {
  completeOwnershipTransfer,
  type CompleteOwnershipTransferCommand,
} from "./repositories/contracts.js";
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
  findActiveCustomerSessionByTokenHash,
  findOwnedConsentEvidence,
  findIdentityCheckByIdempotencyKey,
  findIdentityCheckByProviderReference,
  findLatestUsableOtpChallenge,
  findLatestOtpChallengeForCooldown,
  findOrCreateCustomerAccount,
  findPersonById,
  findPersonByPhone,
  invalidateOtpChallenge,
  markOtpDeliveryFailed,
  invalidateOutstandingOtpChallenges,
  markDuplicateIdentityCheck,
  lockPersonByPhone,
  recordFailedOtpAttempt,
  releaseIdentityCheckClaim,
  reserveIdentityCheck,
} from "./repositories/identity.js";
export { ledgerRepo, type NewLedgerEntry } from "./repositories/ledger.js";
export {
  paymentRepo,
  type NewPaymentTransaction,
} from "./repositories/payments.js";
export { withTransaction, type DatabaseTransaction } from "./transaction.js";
export { migrateDatabase } from "./schema/migration.js";
