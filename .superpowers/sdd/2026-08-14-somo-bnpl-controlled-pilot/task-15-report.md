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
