# Task 11 report — payment ledger and reconciliation

Base: `66c27d2445938201a46b544244c33c17d43487ea`

## TDD evidence

- RED accepted: the first focused payment run failed because the payment webhook service boundary did not exist. The test dependency resolution was corrected without changing the test contract.
- GREEN: the focused payment/API suite passes 14/14 on disposable PostgreSQL. It covers raw-byte capture, verifier failures, duplicate event/provider transaction handling, stable acknowledgements, rollback, exact allocation, quarantine, deposit reconciliation, reversal compensation, maker/checker controls, settlement matching/variance, malformed HTTP JSON, and the absence of a cash endpoint.
- Worker reconciliation job passes 3/3 focused tests and 33/33 for the complete worker suite.
- Customer payment UI passes 3/3; finance payment UI passes 3/3.
- Integration boundary suite passes 22/22, including production connector wrapping for the Somoco payment verifier and rejection of simulator adapters.

## Database and migration evidence

- Database suite passes 31/31 on `postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`.
- Fresh migration journal applies 17 migrations; repeat migration calls leave the count at 17.
- A populated legacy payment/ledger graph survives 0001 through 0016 with payment and ledger amounts unchanged; new receipt/settlement tables are empty and append-only triggers are present.
- Receipt and settlement mutation triggers are installed; ledger/audit append-only controls remain covered by the existing database tests.
- Drizzle generation passes with no schema changes after the 0016 snapshot was added. The existing BigInt schema default was changed to a SQL literal so generation is deterministic.

## Verification gates

- API, worker, customer-web, staff-web, database, and integrations TypeScript checks pass.
- Task 11 lint and Prettier checks pass.
- API, worker, database, integrations, customer-web, and staff-web production builds pass.
- `git diff --check` passes.

## Security and boundary review

- Production app composition requires a registered production payment verifier and SMS connector; absent or unregistered production dependencies fail closed.
- Payment webhook verification receives exact raw bytes and durable inbox acknowledgement is transactional.
- Financial corrections use linked compensation or adjustment ledger entries; payment receipts and settlement batches are database append-only.
- Customer and staff payment reads are session/role scoped. Adjustment mutations require a Finance Officer maker and separate CFO/Compliance checker; system administrators have no payment authority.
- Receipt SMS payloads contain only a validated HTTPS receipt link and current USSD instructions; provider payloads and secrets are not sent to SMS.
- No cash mutation route or vehicle immobilization command was added.

## External readiness note

The repository supplies the provider-neutral Somoco payment verifier and production connector boundary. Somoco must still provide and validate the real payment webhook/settlement contract, production connector provenance, SMS worker deployment configuration, and hosting secrets before accepting live customer payments. No invented provider algorithm or credential is included.

## Fix round 1 — integrity and operations hardening (base `c839fced7727b9e5eaafd8022cbf1bca6c29652a`)

### TDD evidence

- RED accepted: the first fix-round API run had 10 failures/12 passes across 22 tests. The DB linkage check had 1 failure/31 passes; customer and staff payment UI each had 1 failure/3 passes. Failures covered raw-byte/auth ordering, reversal deposit invalidation, settlement replay, persisted policy approval, concurrent posting, explicit channel, customer account/receipt reads, receipt routes, DB reversal linkage, finance controls, and explicit USSD configuration.
- GREEN: the focused real-PostgreSQL API suite passes 22/22 after the fix round. The DB integration/migration suite passes 32/32, the worker suite passes 33/33, integrations 22/22, contracts 9/9, customer payment UI 4/4, and staff payment UI 4/4.
- Raw webhook bytes are authenticated before JSON parsing; reversal/refund compensation rejects the deposit gate; contract/installment rows are locked for atomic posting; and settlement variance cases use persisted dedupe keys with replay-stable settlement batches.
- Customer reads now use posted ledger-backed payments/receipts and expose contract balances/due dates independently of payment history. Receipt links use the authenticated receipt identifier, and staff finance resolution/settlement comparison routes and controls are wired.

### Database and migration evidence

- Fresh migration journal applies 18 migrations and remains at 18 on repeat. Populated migration tests pass through 0017 without changing legacy financial values; reversal/refund rows require an existing linked ledger entry and valid linkage type.
- Migration 0017 adds the persisted Finance/Compliance allocation-policy evidence table, reconciliation dedupe key, reversal self-FK, and reversal-link consistency check. Drizzle generation reports no schema changes after the migration is present.

### Fix-round verification gates

- API, customer-web, staff-web, worker, contracts, integrations, and database typechecks pass; database public-API typecheck also passes.
- Targeted lint passes for changed API/payment files and full lint passes for customer-web, staff-web, worker, database, contracts, and integrations. The full API lint still reports only the three pre-existing unrelated errors in `assets/service.ts`, `products/dto.ts`, and `products/service.gate-status.test.ts`.
- API, database, contracts, integrations, customer-web, and staff-web builds pass. Worker production TypeScript build passes; the standard native esbuild bundle invocation is blocked in this sandbox by access-denied traversal of the pnpm junction target. A preserve-symlinks/external-dependency smoke bundle completes at 133.2 kB; the original Task 11 implementation bundle was previously verified at 480.5 kB.
- Prettier check and `git diff --check` pass for the complete fix-round diff.

### Fix-round review note

- The exact base-to-head review covers the raw transport boundary, payment repository locking/idempotency, policy provenance, receipt authorization/linking, staff finance routes/UI, canonical payment channel, migration constraints, and production USSD fail-closed composition. No simulator, cash, automatic immobilization, guessed SAP behavior, or provider credential was added.

## Fix round 2 — sealed policy and replay races (base `f8d464de7c660162623567cf9ac4bb187bbd469`)

### TDD evidence

- RED accepted: API was 23/27 with four focused failures for canonical worked-example tampering, revoked-policy replay, concurrent receipt notifications, and actor attribution; the DB suite was 32/33 because the runtime role still had policy-table mutation privileges.
- GREEN: the focused real-PostgreSQL API suite passes 28/28 and the database/migration suite passes 33/33.
- Allocation execution is now selected only by the package-owned `SOMOCO_DEPOSIT_OR_INSTALLMENT_V1` representation and sealed hashes. Persisted worked-example JSON is canonicalized and hash-verified; policy version, representation hash, worked-example hash, Finance/Compliance approvers, and approval timestamp must all match. Caller-supplied executable behavior is rejected.
- Provider-transaction insertion uses conflict-safe idempotency and returns the original posted result, receipt identifier, and duplicate marker for concurrent events and revoked-policy replays without surfacing a unique-constraint error.
- Concurrent receipt issuance returns the persisted receipt row and enqueues one receipt SMS outbox message only for the transaction that inserted it; the persisted receipt ID is used in the link.
- Settlement comparison requires an authenticated finance actor and records that staff user on the settlement audit event; unauthorized roles fail closed.

### Database and migration evidence

- Migration `0018_sealed_payment_policy.sql` grants `somo_runtime` SELECT-only access to `payment_allocation_policy` and revokes INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, and TRIGGER privileges. Fresh migration and repeat migration tests pass at 19 migrations.
- The populated migration path applies 0018 after 0017 without changing legacy financial values; the runtime privilege check passes on the resulting schema.

### Fix-round verification gates

- API, customer-web, staff-web, worker, contracts, integrations, database, and testkit TypeScript checks pass; database public-API typecheck also passes.
- Targeted API and database lint pass. Prettier checks pass for all changed TypeScript/JSON files, and `git diff --check` passes.

### Fix-round review note

- The exact base-to-head review covers canonical policy provenance and grants, transaction conflict handling, revoked replay ordering, receipt persistence/outbox idempotency, settlement actor authorization/audit attribution, and migration repeatability. No provider credentials, simulator behavior, cash path, or automatic immobilization was introduced.

## Fix round 3 — external evidence binding and settlement replay hardening (base `42dd005b160cc93fffbafc35cc01b77ba60afbd6`)

### TDD evidence

- RED accepted: the focused API suite passed 28/32 and failed four tests for behavior-digest binding, missing/mismatched external evidence, caller behavior injection, and concurrent reversal compensation. The staff payment workspace passed 4/5 and failed because MD still saw settlement comparison.
- GREEN: the focused real-PostgreSQL API suite passes 32/32; the database/migration suite passes 34/34; and the staff payment workspace passes 5/5.
- Allocation execution is now an immutable package-owned implementation with an explicit behavior digest. Production composition validates externally supplied Finance/Compliance evidence containing a canonical artifact hash, distinct approver identities, separate approval timestamps, and non-empty signatures; no package-owned worked-example prose, default approvers, or caller decision function is accepted. Persisted rows must match the evidence artifact/hash and executable behavior digest.
- Reversal/refund compensation uses the same conflict-safe provider-transaction insertion path as normal postings. Concurrent events with different IDs now return one persisted compensation result and one duplicate result without a raw unique-constraint error or second balance/ledger mutation. Duplicate reversal replay does not consult a newly revoked posting policy.
- Settlement comparison route authorization now matches the service role set (Finance Officer, CFO, or Compliance Auditor), and the staff UI no longer exposes the control to MD.

### Database and migration evidence

- Migration `0019_external_payment_policy_evidence.sql` adds behavior-digest, external artifact/hash, signatures, and separate Finance/Compliance approval timestamps. Legacy APPROVED policy rows without this evidence are revoked before the approval constraint is installed; no evidence or signature defaults are fabricated.
- Fresh migration and repeat migration tests pass at 20 migrations. The populated migration suite applies 0019 after 0018, preserves legacy payment/ledger values, and verifies legacy approved policy rows are revoked safely.

### Fix-round verification gates

- API, staff-web, and database focused gates pass with the counts above; API and database TypeScript checks pass, including the public DB API typecheck.
- API, database, and staff-web TypeScript checks pass; the database public-API typecheck also passes. Targeted ESLint passes for every changed source/test file, Prettier passes for the exact changed TypeScript/JSON/report files, and `git diff --check` passes.
- Production API and database TypeScript builds pass; the staff-web Vite production build passes with a 232.92 kB JavaScript bundle.

### Fix-round review note

- The exact base-to-head review covers immutable allocation behavior/evidence provenance, SELECT-only policy storage, conflict-safe reversal/refund replay, route/UI authorization parity, migration repeatability, and populated-row safety. No real signatures, provider credentials, simulator behavior, cash path, or automatic immobilization was added.

## Fix round 4 — verified signed allocation-policy evidence (base `ed05042ab2bf8b97c3b15b2070b1ed9a3db03853`)

### TDD evidence

- RED accepted: the preserved API payment matrix remained green at 32/32, while five new focused assertions failed: three because no canonical evidence verifier was called or bound to the posting, and two because production composition did not yet require or reject simulator policy verifiers.
- GREEN: the focused real-PostgreSQL API payment suite passes 35/35. It covers canonical signed-byte construction, artifact/signer/timestamp/version/execution-key/engine-digest binding, untrusted and swapped evidence rejection, attestation persistence, and replay after policy revocation without a second verification call.
- Production payment composition passes 2/2: an attested verifier is mandatory, direct simulators are rejected, and wrappers without the package-issued production capability are rejected. The integrations boundary suite passes 23/23, including the new provider-neutral allocation-policy verifier connector.

### Implementation and boundary evidence

- `AllocationPolicyEvidenceVerifier` is a provider-neutral integration port. Trusted key custody, signature format, and signer roots remain external; the application derives canonical signed bytes and never accepts caller-supplied bytes or executable allocation behavior.
- The signed document covers the worked-example artifact hash, distinct Finance/Compliance signer IDs, separate approval timestamps, policy version, package execution key, and the runtime source digest of the exact allocation function. Changing that function changes the required policy digest.
- Production `buildApp` requires a verifier registered through the constrained production connector boundary. Direct or wrapped simulators and unregistered adapters fail closed. Only the verifier's returned attestation reference is persisted in matched ledger-entry metadata; no production evidence, signature, key, or default fixture is fabricated.
- Verification is cached for the service lifetime and performed only for a new successful event after inbox insertion; duplicate inbox replays return their durable acknowledgement without reapproval or re-verification. Failed verification rolls back the inbox/posting transaction.

### Fix-round verification gates

- API and integrations TypeScript checks and production builds pass; targeted ESLint and Prettier checks pass for every changed source/test file; `git diff --check` passes.
- No schema or migration change was required. The existing 20-migration chain and populated/repeat migration evidence from fix round 3 remain applicable; attestation provenance is stored in existing ledger metadata.

### Fix-round review note

- The exact base-to-head review covers canonical attestation construction, runtime allocation-engine digest binding, trusted production connector capability, simulator fail-closed behavior, verifier error sanitization, duplicate replay ordering, and provenance persistence. No provider keys, credentials, signature algorithm, payment endpoint, simulator default, cash path, or automatic immobilization was added.

## Fix round 5 — verifier-independent payment replay (base `21f63042d946a2ddf5a26066b4ee34cbd34f2db5`)

### TDD evidence

- RED accepted: a fresh webhook service replaying a committed provider transaction with a revoked policy failed with `ALLOCATION_POLICY_EVIDENCE_NOT_VERIFIED` because the unavailable external verifier ran before the durable duplicate lookup.
- GREEN: the focused real-PostgreSQL API payment suite passes 36/36. The new case proves a new event ID with the same provider transaction returns the original posted payment ID/outcome and `duplicate: true`, invokes the fresh service's unavailable verifier zero times, and does not require active policy approval.

### Implementation and verification gates

- The ledger service now exposes a transaction-aware durable duplicate-provider lookup. The webhook inserts the new inbox event, checks the committed provider transaction before external allocation-policy verification, completes the new inbox acknowledgement from the persisted ledger/receipt result, and only verifies evidence for a new posting. No process cache is used for correctness; raw-byte provider verification and event-inbox idempotency remain unchanged.
- API production-composition tests pass 2/2; integrations boundary tests pass 23/23. API/integrations typechecks and production builds, targeted ESLint, Prettier, and `git diff --check` all pass.
- No migration was required; this round uses the existing payment transaction/provider uniqueness and inbox persistence controls.

### Fix-round review note

- The exact base-to-head review covers durable duplicate lookup ordering, stable acknowledgement construction, policy-revocation replay, transaction reuse, and preservation of reversal/refund handling. No provider credentials, simulator behavior, signature algorithm, migration, cash path, or automatic immobilization was added.
