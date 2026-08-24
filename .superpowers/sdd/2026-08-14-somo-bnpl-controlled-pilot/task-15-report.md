# Task 15 controlled-pilot evidence report — fix round 2

Base: `6b76c1e` (`fix: exercise real controlled pilot boundaries`)
Scope: complete the missing real public product/signature/deposit boundaries and prove the controlled pilot through production application composition, disposable PostgreSQL, simulator ports, worker dispatch, and the actual customer UI route.
Environment: disposable PostgreSQL only (`postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`), simulator adapters only, synthetic identities/documents/payments. No production target, real provider, real hosting, backup/restore, penetration test, or staff-signed UAT was used.

## TDD RED/GREEN

The first fix-round boundaries were tested at the public boundary before implementation:

```text
Product linkage RED: the real customer applicant PATCH returned 400 when the public productId was submitted because the public product selection was not exposed or validated. GREEN after productId was accepted and checked against the active product/model.
Signature action RED: POST /v1/customer/applications/:applicationId/signatures returned 404. GREEN after authenticated applicant and guarantor actions persisted offer-bound evidence and replayed idempotently.
Pre-contract deposit RED: a simulator payment could be quarantined, but no public path reconciled it to the accepted offer before assignment/contract generation. GREEN after the payment webhook matched application+offer context, persisted reconciliation/receipt/audit evidence, and contract generation bound the matched transaction to a DEPOSIT ledger entry.
Signature execution guard RED: physical execution returned 200 without public applicant/guarantor signature evidence. GREEN after execution rejected the same public flow with 409 SIGNATURE_EVIDENCE_INCOMPLETE.
Arrears boundary RED: the staff arrears-compute route was absent (404), then returned a serialization failure on bigint output. GREEN after the staff route serialized the real CollectionsService result and asserted distinct THREE_CONSECUTIVE_MISSED and THREE_TOTAL_UNPAID signals.
```

The real replacement composes `buildApp`, repeat-safe migrations, public OTP/customer sessions, signed staff cookie sessions, `@somo/integrations` simulator ports, the production worker outbox dispatcher, and public HTTP routes. No standalone in-memory application or duplicated business rule is used. The happy path enters customer, guarantor, staff, and provider actions through those boundaries and reads durable state back from PostgreSQL.

Focused real-app GREEN:

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts
Result: Test Files 1 passed; Tests 6 passed

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts test/e2e/information-request.spec.ts test/e2e/payment-replay.spec.ts test/e2e/recovery-control.spec.ts test/e2e/ownership-transfer.spec.ts
Result: Test Files 5 passed; Tests 15 passed
```

The happy scenario proves, in order: public applicant product selection; independent applicant and guarantor OTP/NIA/consent/document evidence; applicant and guarantor signature actions bound to the accepted offer; six-stage approval with declared roles, actor/stage/idempotency history, wrong-role rejection, and licence-disallowed tenure rejection; accepted offer; simulator payment deposit reconciliation; declared `INVENTORY_OFFICER` VIN, registration, insurance, and assignment; physical PDF execution; customer and staff handover; activation; arrears recomputation; six simulator repayment events; duplicate provider transaction replay; clean settlement; dual finance/business approvals; and ownership transfer.

Durable assertions cover privacy signature rows, approval/audit rows, deposit reconciliation, payment transaction and receipt uniqueness, DEPOSIT and REPAYMENT ledger entries, repayment schedule/installment balances, contract state, settlement approvals, ownership-transfer state, and replay/idempotency evidence. The contract ownership-holder schema remains `SOMOCO` by design; the completed transfer is asserted in the ownership-transfer record and public response.

The four plan-required adverse entry points remain meaningful real-app HTTP specs and share only the real composition helper:

- `test/e2e/information-request.spec.ts`: information request/resubmission, NIA outage then recovery, three failed OTP codes, and infected-document rejection.
- `test/e2e/payment-replay.spec.ts`: unmatched replay invariants and payment-simulator outage then recovery.
- `test/e2e/recovery-control.spec.ts`: arrears queue, unauthorized tracker lookup, and explicit recovery/immobilization denial.
- `test/e2e/ownership-transfer.spec.ts`: outstanding-balance transfer denial.

## Bounded load and resilience evidence

```text
Command: node node_modules/tsx/dist/cli.mjs test/load/application-flow.ts
Database: postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test
Output: mode=SIMULATED_PROXY; sampleSize=32; concurrency=8; requestStatusCodes=32x202; replayStatus=202; concurrentWebhook.pass=true; providerResilience={outageStatus:401,recoveryStatus:202,pass:true}; workerRestartAndReclaim={attemptOutcomes:[ABANDONED,PUBLISHED],queueAgeMs:1977327342,pass:true}; simulatedProxyP95RequestLatencyMs=198.85; simulatedProxyPass=true
```

The script uses the real API webhook route and disposable simulator. It separately measures request p95, database queue age, simulator provider outage/recovery, and the production worker's database claim/restart/reclaim path. It never equates request latency with queue age. Hosting capacity, real-provider resilience, backup/restore integrity, and signed UAT remain pending rather than fabricated.

The production worker integration gate also passed:

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts apps/worker/test/database-outbox.integration.test.ts
Result: Test Files 1 passed; Tests 6 passed
```

## Browser/UI evidence

The root Playwright config runs the actual customer Vite app and explicitly selects `channel: "chrome"`; customer/staff configs retain the same channel. The test does not use inline HTML or a fixture browser page.

```text
Command: node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4178
Command: node node_modules/@playwright/test/cli.js test --config playwright.config.ts --reporter=line
Result: 1 passed — test/e2e/pilot-happy-path.spec.ts serves the actual customer sign-in route in Chrome.
```

The first browser assertion expected the nonexistent `Request code` label; the actual production route rendered `Send code`. The assertion was corrected and the rerun passed. The disposable Vite process was terminated after the run.

## Compatibility and affected verification

Existing route-composition fixtures do not install the optional Fastify CSRF decorator. The signature route uses CSRF whenever the production `buildApp` decorator exists, while allowing those isolated route fixtures to register. `buildApp` always passes `requireSignatureEvidence: true`. Direct non-production contract-service fixtures may use their pre-existing unlinked reconciled evidence rows for compatibility; production and the controlled pilot require a payment transaction binding and durable DEPOSIT posting.

```text
node node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json       # pass
node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json    # pass
node node_modules/typescript/bin/tsc --noEmit -p packages/db/tsconfig.json    # pass
applications.e2e.test.ts                                                        # 15 passed
assets-contracts.e2e.test.ts                                                     # 11 passed
worker database-outbox.integration.test.ts                                      # 6 passed
```

No `pnpm install` or `pnpm add` was run. No production module was targeted by a test service, and the only database URL accepted by the real pilot helper is the disposable test URL above.

## Pilot documents and release gates

Updated unsigned templates:

- `platform/docs/pilot/uat-script.md`
- `platform/docs/pilot/go-no-go-checklist.md`
- `platform/docs/pilot/rollback.md`

They now describe the real public-boundary evidence and keep real-provider, hosting/TLS/capacity, legal/privacy, security/penetration, backup/restore, and signed UAT gates pending. They do not claim production launch readiness. SAP synchronization remains off pending discovery.

## Self-review

Exact self-review range: `6b76c1e..FIX_HEAD` (all current worktree changes before the fix commit). Reviewed for fake harness imports, literal token-role maps, direct workflow SQL, `setArrears`/`seedActiveContract`, missing role guards, future provider timestamps, weak replay assertions, production targets, generated artifacts, and fabricated provider/hosting/restore/UAT evidence. `rg` confirms no `pilot-harness` or `attachProduct` references remain. The public signatures, deposit reconciliation, worker, adverse, load, and browser paths are real and bounded.

Commit: `fix: complete real controlled pilot financial and ownership flow` (to be recorded after final verification).

## Fix round 3 — integrity and resilience re-review

The independent re-review findings were reproduced at the real boundaries before implementation:

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts
RED result: Test Files 1 failed; Tests 9 total, 5 passed, 4 failed. The failures were receipt_contract_id null after contract binding, both distinct concurrent deposits POSTED, customer-support arrears compute not rejected with 403, and provider outage returned 401 instead of retryable 503.
```

The fixes are now implemented and covered by focused regression assertions:

- Pre-contract reconciliation uses an insert-only unique `(application_id, offer_id)` claim. Exactly one concurrent payment wins; every losing payment remains a durable payment transaction, reconciliation case, and `DEPOSIT_PAYMENT_QUARANTINED` audit event with the winning payment reference. The loser never replaces the winner's reconciliation or receipt.
- Contract binding updates the matching pre-contract receipt's `contract_id` in the same transaction as payment binding. Migration `0031_bind_payment_receipt_contract` permits only the append-only-safe null-to-contract receipt binding; other financial history mutations remain rejected.
- Arrears compute now authorizes `collections.compute` through the existing access service, restricted to `RECOVERY_OFFICER`, records actor/request context in `ARREARS_COMPUTED`, and retains access-service `ACCESS_DENIED` audit evidence.
- Root Playwright uses `reuseExistingServer: false`, so the checked-out customer app is always launched and Playwright owns deterministic process cleanup.
- The load runner models 5,200 applications/month and all expected staff queues, computes a finite-population 95%/5%-margin sample, exercises concurrent webhooks, worker abandon/reclaim, provider outage/recovery, replay/reconciliation counts, dynamic queue age, explicit thresholds, and refuses any `DATABASE_URL`, production environment, or non-disposable test URL.
- Provider verification failures still map to 401 for authentication/signature failures. Provider infrastructure unavailability now stores the raw body/signature/timestamp in the inbox without posting money, returns 503 `PAYMENT_PROVIDER_UNAVAILABLE`, and claims/replays the preserved inbox row after recovery with one idempotent financial post.

Focused real-app GREEN after these changes:

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts
Result: Test Files 1 passed; Tests 9 passed (9/9).

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts test/e2e/information-request.spec.ts test/e2e/payment-replay.spec.ts test/e2e/recovery-control.spec.ts test/e2e/ownership-transfer.spec.ts
Result: Test Files 4 passed; Tests 9 passed (9/9).
```

Affected database and compatibility verification, run serially against the disposable PostgreSQL instance where applicable:

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/payments.integration.test.ts
Result: Test Files 1 passed; Tests 37 passed.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/assets-contracts.e2e.test.ts
Result: Test Files 1 passed; Tests 11 passed.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/collections.hardening.test.ts
Result: Test Files 1 passed; Tests 11 passed.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts apps/worker/test/database-outbox.integration.test.ts
Result: Test Files 1 passed; Tests 6 passed.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts
Result: Test Files 1 passed; Tests 38 passed, including repeat-safe application of all 31 migrations.

Command: node node_modules/vitest/vitest.mjs run packages/db/src/outbox-context.test.ts
Result: Test Files 1 passed; Tests 1 passed.

Command: node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/production-payment-composition.test.ts
Result: Test Files 1 passed; Tests 2 passed; simulator policy verifiers remain rejected in production composition.

Command: node node_modules/vitest/vitest.mjs run --config apps/worker/vitest.config.ts apps/worker/test/reconcile-payments.test.ts
Result: Test Files 1 passed; Tests 3 passed.
```

Type, lint, format, and whitespace checks:

```text
Command: node node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json
Result: pass (exit 0)
Command: node node_modules/typescript/bin/tsc --noEmit -p packages/db/tsconfig.json
Result: pass (exit 0)
Command: node node_modules/typescript/bin/tsc --noEmit -p apps/worker/tsconfig.json
Result: pass (exit 0)
Command: node node_modules/eslint/bin/eslint.js <all changed TypeScript files>
Result: pass (exit 0)
Command: node node_modules/prettier/bin/prettier.cjs --check <all changed TypeScript/JSON files>
Result: All matched files use Prettier code style.
Command: git diff --check
Result: pass (only Git's existing LF/CRLF normalization warnings were reported).
```

Bounded load/resilience evidence, latest run:

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/tsx/dist/cli.mjs test/load/application-flow.ts
Result: mode=SIMULATED_PROXY; persistence=DISPOSABLE_POSTGRESQL; modeledMonthlyApplications=5200; sampleMethod=FINITE_POPULATION_95_PERCENT_5_PERCENT_MARGIN; sampleSize=358; sampleFraction=0.0688; concurrency=8; requestStatusCodes=358x202; simulatedProxyP95RequestLatencyMs=49.72 (threshold 1000); replayStatus=202; replayCount=1; reconciliationCases=359; paymentTransactions=359; maximumDbQueueAgeMs=84.159 (threshold 5000); simulatedProxyPass=true; concurrentWebhook={requests:358,accepted:358,pass:true}; providerResilience={outageStatus:503,recoveryStatus:202,replayStatus:202,preservedInboxCount:1,paymentCountAfterRecovery:1,replayCount:1,pass:true}; workerRestartAndReclaim={attemptOutcomes:[ABANDONED,PUBLISHED],queueAgeMs:84.159,pass:true}; all VERIFICATION, BSM_INITIAL, BSM_FINAL, AGM, CFO, MD, FINANCE_RECONCILIATION, and COLLECTIONS staff queue models passed. Hosting capacity, restore integrity, and signed UAT remain pending external rehearsal/sign-off.

Command: $env:DATABASE_URL='postgresql://production.example/somo'; Remove-Item Env:TEST_DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/tsx/dist/cli.mjs test/load/application-flow.ts
Result: rejected before database access with CONTROLLED_PILOT_DATABASE_URL_MUST_NOT_BE_SET (exit 1); guard wrapper returned pass.
```

Browser boundary and cleanup evidence:

```text
Command: node node_modules/@playwright/test/cli.js test --config playwright.config.ts --reporter=line
Result: 1 passed — `test/e2e/pilot-happy-path.spec.ts` served the checked-out customer Vite app in Chrome; `reuseExistingServer=false` launched and Playwright cleaned up the app process.
```

Limitations remain unchanged and explicit: no real provider, production database, hosting/capacity rehearsal, real backup restore, penetration/security assessment, or staff-signed UAT was used. The load output is a disposable PostgreSQL/simulator measurement and does not claim production capacity or launch readiness.

## Fix round 4 — runtime receipt binding and nested provider outage recovery

Scope: correct the two independent production findings from the Task 15 re-review and extend the customer receipt regression. Only the disposable PostgreSQL service (`postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`) was used for database-backed checks. No dependencies were installed, no database suites were run concurrently, and no production target or real provider was contacted.

### TDD RED

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t "allows the runtime role to bind only an unbound receipt contract"
Result: 1 failed, 38 skipped. Expected has_column_privilege('somo_runtime', 'payment_receipt', 'contract_id', 'UPDATE') to be true; received false. Table UPDATE, receipt-number UPDATE, and DELETE were already false. This reproduced that migration 0031 had made the trigger transition legal but had not restored a runtime capability.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/payments.integration.test.ts -t "preserves a nested production transport outage and posts recovery once"
Result: 1 failed, 37 skipped. The public payment webhook received a production-bound connector error `TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })`; expected HTTP 503, received HTTP 401. This reproduced top-level-only outage detection.
```

### GREEN

Migration `0032_runtime_receipt_contract_binding` first revokes table-wide UPDATE/DELETE and then grants only `UPDATE (contract_id)` to `somo_runtime`. `REVOKE` and column-level `GRANT` are repeat-safe and do not rewrite populated receipt rows. The existing `payment_receipt_append_only` trigger still permits only the first null-to-contract binding and rejects all other updates.

`isPaymentProviderUnavailable` now walks at most eight Error/object `cause` links, records seen objects to terminate cycles, and protects property reads. It recognizes an unavailable code on each visited error/object but leaves ordinary signature failures on the existing 401 path.

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t "allows the runtime role to bind only an unbound receipt contract"
Result: 1 passed, 38 skipped. An actual `SET LOCAL ROLE somo_runtime` transaction bound an unbound receipt's contract_id. Runtime receipt-number UPDATE and DELETE were rejected with 42501; attempting to clear the now-bound contract_id was rejected by the append-only trigger with 55000.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/payments.integration.test.ts -t "preserves a nested production transport outage and posts recovery once"
Result: 1 passed, 37 skipped. The public webhook returned 503 PAYMENT_PROVIDER_UNAVAILABLE, durably stored the exact raw-body base64 before posting money, then recovery plus replay resulted in exactly one payment transaction, receipt, credit ledger entry, and processed inbox record.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts -t "completes customer onboarding, durable approvals, and an accepted offer"
Result: 1 passed, 8 skipped. After contract generation binds the reconciled deposit receipt, the authenticated applicant retrieves it through both GET /v1/customer/receipts and GET /v1/customer/receipts/:receiptId; the public response matches the receipt id, payment transaction id, provider transaction id, amount, and POSTED state.
```

### Final focused verification

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t "applies the complete migration journal once and is repeat-safe"
Result: 1 passed, 38 skipped. The journal applies all 32 migrations, and two repeat migrations add no further migration rows.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/payments.integration.test.ts -t "authenticates raw malformed bytes before JSON parsing"
Result: 1 passed, 37 skipped. A genuine invalid signature remains HTTP 401 INVALID_SIGNATURE.

Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts test/e2e/payment-replay.spec.ts
Result: Test Files 1 passed; Tests 2 passed.

Command: node node_modules/eslint/bin/eslint.js apps/api/src/modules/payments/webhook-service.ts apps/api/test/payments.integration.test.ts apps/api/test/task15-controlled-pilot.e2e.test.ts packages/db/src/db.integration.test.ts
Result: pass (exit 0).

Command: node node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json
Result: pass (exit 0).

Command: node node_modules/typescript/bin/tsc --noEmit -p packages/db/tsconfig.json
Result: pass (exit 0).

Command: node node_modules/prettier/bin/prettier.cjs --check apps/api/src/modules/payments/webhook-service.ts apps/api/test/payments.integration.test.ts apps/api/test/task15-controlled-pilot.e2e.test.ts packages/db/src/db.integration.test.ts packages/db/drizzle/meta/_journal.json
Result: All matched files use Prettier code style.

Command: git diff --check
Result: pass; only the worktree's existing LF/CRLF normalization warnings were emitted.
```

The earlier external release gates remain unchanged: this is not evidence of a real provider, production runtime connection, hosting/capacity rehearsal, backup/restore validation, penetration/security assessment, legal/privacy approval, or staff-signed UAT. Those gates remain pending and the pilot remains blocked until their separately signed evidence exists.
