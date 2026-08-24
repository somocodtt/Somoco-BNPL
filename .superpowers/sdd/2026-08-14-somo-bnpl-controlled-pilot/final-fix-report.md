# Final controlled-pilot fix report

Date: 2026-08-24

Review base: `34536948422efc4b6a176eb778328661c70d1989`

Database boundary used for every PostgreSQL check:
`postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`.
Database suites were run serially. No dependency installation, production endpoint,
real provider, or production data was used.

## Findings and TDD evidence

### 1. Canonical money validation

- RED: contract-boundary cases for `99`, `999`, signed-bigint maximum, and
  maximum + 1 exposed lexicographic rejection of valid leading-9 values and
  acceptance of a value PostgreSQL cannot store. The verified webhook boundary
  also accepted `9223372036854775808` before persistence.
- GREEN: one shared BigInt-based `parseMinorUnits` now enforces
  `0..9223372036854775807` and is used by the money DTO and webhook boundary.
- Evidence: contracts `12/12`; focused API maximum+1 rejection included in the
  final invariant pass.

### 2. Read-only auditors and business privacy roles

- RED: negative HTTP/service cases showed `COMPLIANCE_AUDITOR` and
  `SYSTEM_ADMIN` could reach financial, product, migration, and privacy
  mutations; no distinct business privacy approver existed end to end.
- GREEN: `COMPLIANCE_OFFICER` and `DPO` are carried through API types, database
  enum migration, staff UI types, and route/service policies. Auditors and
  technical administrators remain read-only; officer/DPO positive cases prove
  the business mutation boundary.
- Evidence: privacy/access/product/payment role targets passed, and the final API
  suite passed `271/271` before the final monotonic-event repair; a fresh full API
  result is recorded in Final verification below.

### 3. Current, state-bound settlement approvals

- RED: approval tests showed stale approvals could survive a financial mutation
  and the old unique key prevented a valid reapproval bundle.
- GREEN: each approval records contract version, ledger head/digest, balance,
  reconciliation checkpoint, and bundle digest. Approval requires ACTIVE, zero
  balance, and a clean contract-bound reconciliation state. Settlement compares
  both approvals with a fresh snapshot; stale bundles fail and reapproval works.
- Evidence: focused approval/invalidation cases passed in the final invariant
  pass; database migration backfill and repeat checks passed.

### 4. Explicit reversal lifecycle

- RED: new integration cases exposed that reversal/refund notifications were not
  one lifecycle, resolved reversal history still blocked replacement settlement,
  and post-settlement adjustments could reopen transferred economics.
- GREEN: compensation is linked to its original payment and immutable ledger
  entry, with one partial-unique lifecycle per original. Reversal and refund share
  that identity. Resolved cases stop gating settlement; post-settlement/transfer
  reversals and adjustments are quarantined for human exception.
- Evidence: duplicate/lifecycle, replacement settlement, and post-settlement
  quarantine targets passed (`3/3`); the compact final invariant pass passed all
  selected reversal cases.

### 5. Authoritative ownership transition

- RED: fresh contract/customer reads after transfer still reported Somoco, and
  no database boundary required coherent contract, vehicle, registration, and
  transfer evidence.
- GREEN: transfer atomically changes contract to `TRANSFERRED`/`CUSTOMER`, vehicle
  to `TRANSFERRED`, copies the latest Somoco registration to a customer record,
  and binds the accepted registration evidence. Deferred cross-table triggers
  reject partial transitions. Staff/customer DTOs expose authoritative ownership.
- Evidence: focused ownership/coherence and Task 15 ownership flow passed; DB
  locked transfer test and the final invariant ownership case passed.

### 6. Non-poisonable outage evidence

- RED: an attacker could preseed unverified event type/payload under a provider
  transaction ID and make it look canonical when the provider recovered.
- GREEN: unverified attempts use `unverified:sha256:<digest>` and the fixed event
  type `PAYMENT_VERIFICATION_UNAVAILABLE`. Verified recovery uses the verified
  canonical provider ID and links to the raw preservation record. Reserved
  canonical namespaces are rejected for unverified input.
- Evidence: adversarial preseed/recovery exactly-once target passed (`1/1`) and is
  included in the compact final invariant pass.

### 7. Durable production privacy

- RED: persistence regression failed because
  `createPostgresPrivacyService` did not exist; production composition accepted
  an un-attested Map implementation. A later focused regression also caught that
  equal clock timestamps made OPEN/IN_REVIEW ordering depend on UUID order.
- GREEN: production privacy is PostgreSQL-backed and append-only for request
  events, corrections, restrictions, legal holds, retention policy/run evidence,
  anonymization evidence, and central audit events. Direct UPDATE/DELETE is
  rejected. The Map service is test-only and production requires the durable
  attestation. Successive request events advance monotonically by at least 1 ms.
- Evidence: persistence/fresh-instance and production-composition targets passed;
  equal-clock RED was followed by a GREEN compact invariant pass (`9/9`).

### 8. API test discovery and clean production output

- RED: real-boundary tooling regression failed `2/2`: the clean API build entry
  point and separate pilot config did not exist, and package-root discovery was
  unconstrained.
- GREEN: API Vitest has an API root, explicit source/test includes, and excludes
  `dist` plus unrelated apps/workspace E2E. Production build removes `dist` and
  excludes source-located tests. Cross-workspace pilot E2E uses
  `vitest.pilot.config.mts`.
- Evidence: after creating a stale `dist/stale.test.js`, the build/discovery
  boundary passed `2/2`; no emitted `*.test.js`, stale test, duplicate discovery,
  or unrelated app was found.

### 9. Worker database isolation

- RED: worker config regression received `undefined` instead of
  `fileParallelism: false`.
- GREEN: default worker Vitest disables file-level parallelism.
- Evidence: config regression `1/1`; deterministic full worker suite `49/49`.

### 10. Clean lint gates

- RED: focused lint reported five errors: two missing caught causes, unused test
  value, unused financing type, and mutable-never-reassigned financing value.
  Staff lint also failed because `apps/staff-web/test` does not exist.
- GREEN: caught causes are retained, unused values/import removed, `const` used,
  staff lint path corrected, and changed files formatted without extra EOF space.
- Evidence: full app/package/test lint returned zero errors; Prettier check and
  `git diff --check` passed.

### 11. Deterministic customer offer tests

- RED: on 2026-08-24 the fixed 2026-08-21 offer made two of five tests render the
  expired state (`2 failed, 3 passed`).
- GREEN: the live fixture expires relative to test execution; the explicit
  `EXPIRED` case remains unchanged.
- Evidence: focused `5/5`; full customer suite `34/34`.

## Narrow rulings

1. `COMPLIANCE_AUDITOR` may read cross-subject privacy evidence but may not mutate
   it. `COMPLIANCE_OFFICER` and `DPO` are the business mutation roles. Technical
   `SYSTEM_ADMIN` is not a substitute.
2. A reversal and refund for one original payment are the same compensation
   lifecycle. Historical resolved cases remain immutable but do not gate a clean
   replacement payment.
3. Reconciliation cases gate a contract only when explicitly contract-bound or
   linked through a payment transaction. An unbound legacy case cannot block every
   unrelated contract.
4. Ownership transfer copies the latest authoritative Somoco registration and
   binds the accepted transfer document; it does not rewrite prior registration
   history.
5. Append-only privacy event ordering must be deterministic even under a frozen
   or coarse clock, so a later event advances beyond the prior persisted event.
6. API package tests and cross-workspace pilot E2E are separate discovery
   products; the pilot matrix is not compiled into or discovered from API `dist`.

## Final verification

All commands used linked workspace binaries; no `pnpm` wrapper or install command
was used.

- Formatting/diff: Prettier clean on changed TS/TSX/JSON/MJS/MTS/Markdown;
  `git diff --check` clean.
- Lint: full API, worker, customer, staff, contracts, DB, domain, integrations,
  testkit, and tooling source set passed.
- Typecheck: `9/9` project configurations passed.
- Clean build: contracts, DB, domain, integrations, testkit, API, worker bundle,
  customer web, and staff web passed after explicit output cleanup.
- API: `24` files, `271/271` tests in the final post-repair run.
- Worker: `8` files, `49/49` tests.
- Customer web: `7` files, `34/34` tests.
- Staff web: `8` files, `29/29` tests.
- Contracts: `1` file, `12/12` tests.
- Domain: `6` files, `37/37` tests.
- Integrations: `2` files, `25/25` tests.
- Database/migrations: `2` files, `41/41` tests, including complete-journal
  repeat safety, populated 0032-to-0033 backfill, immutable history, and locked
  ownership transition.
- Focused final money/privacy/settlement/reversal/ownership/outage pass: `3`
  files, `9/9` selected tests.
- API clean-build/discovery regression: `1` file, `2/2` tests.
- Task 15 public pilot matrix: `5` files, `18/18` tests.
- Workspace verifier: `Workspace configuration verified.`
- Signed synthetic test pilot gates: `10/10` required test gates verified.
- Default production gate verifier: correctly failed closed with
  `PILOT_GATE_EVIDENCE_FILE_REQUIRED`.

## Explicitly pending external gates

The branch is not being declared production-ready. The following remain pending
and cannot be replaced by simulator/test evidence:

- real NIA, SMS, and payment provider contracts, credentials, sandbox evidence,
  SLAs, and signed adapter results;
- production hosting, TLS, capacity, networking, monitoring, and secrets review;
- legal/licensing/disclosure approval and privacy/DPIA approval;
- backup/restore rehearsal with measured integrity/RPO/RTO;
- penetration/security assessment and accepted residual risk;
- named staff training and signed role-by-role UAT/business approval.

No external gate was fabricated or marked complete.
