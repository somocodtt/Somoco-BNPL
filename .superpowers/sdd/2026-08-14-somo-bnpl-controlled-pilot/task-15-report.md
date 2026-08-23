# Task 15 controlled-pilot evidence report — fix round 1

Base: `dbd05ed0f7099a1a66cfcfe01b24197f7ce1c0c3`
Fix review base: `71b0f1dd2a05923886487ae34ff4ec4d8b1a7597`
Scope: replace the rejected standalone in-memory harness with real application composition, retain only executable public-boundary evidence, and preserve unsigned/pending release gates.
Environment: disposable PostgreSQL only (`postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`), simulator adapters only, synthetic identities/documents/payments. No production target, real provider, real hosting, restore rehearsal, penetration test, or staff-signed UAT was used.

## TDD RED/GREEN

The rejected `platform/test/e2e/support/pilot-harness.ts` was removed. The first real-app boundary command then failed because the old browser spec still imported that fixture:

```text
Command: node apps/customer-web/node_modules/@playwright/test/cli.js test --config playwright.config.ts test/e2e/pilot-happy-path.spec.ts
Result: FAIL — Cannot find module './support/pilot-harness.js'
```

The real replacement composes `buildApp`, database migration/reset, public OTP/customer sessions, signed staff cookie sessions, simulator ports, and public HTTP routes. Focused GREEN evidence:

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts
Result: Test Files 1 passed; Tests 5 passed
```

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts test/e2e/information-request.spec.ts test/e2e/payment-replay.spec.ts test/e2e/recovery-control.spec.ts test/e2e/ownership-transfer.spec.ts
Result: Test Files 5 passed; Tests 9 passed (39.55s)
```

The five real-app tests cover the happy onboarding/approval/offer flow plus wrong-role/licence, unmatched provider replay, inventory registration/insurance/deposit guards, and provider-verification/recovery-role fail-closed boundaries. Approval evidence is read back from durable `audit_event` rows (six stages, five distinct actors, six idempotency keys); guarantor consent, verified identity, and accepted document evidence is read back from the privacy schema. The unmatched payment path produces one persisted payment transaction and one reconciliation case; a second provider event with the same provider transaction is acknowledged as a duplicate without a second transaction/case.

The four plan-required adverse entry points were restored as executable Vitest real-app HTTP specs (not browser fakes): `test/e2e/information-request.spec.ts`, `payment-replay.spec.ts`, `recovery-control.spec.ts`, and `ownership-transfer.spec.ts`. They share `support/real-pilot.ts` and `support/vitest-http.ts`; Playwright's browser project runs only the actual customer UI spec, while `test:pilot` runs all nine real API tests.

## Exact public-boundary limitations

These are recorded as blockers rather than bypassed:

- `POST /v1/customer/applications` accepts no product identifier and no product-assignment route exists. The composition uses one setup-only `application.product_id` linkage after the public draft is created; product rule creation and publishing still enter the real maker/checker routes. This missing assignment boundary is not a business-rule implementation.
- `POST /v1/staff/applications/:applicationId/asset-assignment` returns `409 DEPOSIT_RECONCILIATION_REQUIRED` after the accepted offer and real registration/insurance routes complete. The payment webhook only posts/reconciles against an existing contract reference, while `POST /v1/staff/applications/:applicationId/contracts` requires an assignment. There is no public deposit-reconciliation-before-contract command, so posted ledger/receipt replay, contract execution, handover, activation, repayment settlement, and ownership transfer cannot be honestly claimed in this task without a direct workflow-table shortcut.
- No public customer/guarantor signature action exists. The execution route accepts staff-supplied applicant/guarantor person IDs, but does not provide a customer signature evidence boundary. The UAT/go-no-go documents keep this gate blocked.

The adverse inventory test demonstrates the actual guard with the declared `INVENTORY_OFFICER` role; no `OPERATIONS_OFFICER` or invented role is used. All action/event timestamps in the executable scenarios are deterministic past timestamps relative to the test run, except the fixed offer expiry required by the production offer validity guard.

## Bounded load/resilience evidence

```text
Command: $env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/tsx/dist/cli.mjs test/load/application-flow.ts
Output:
{"mode":"SIMULATED_PROXY","persistence":"DISPOSABLE_POSTGRESQL","simulator":"SOMOCO_PAYMENTS_TEST_ADAPTER","modeledMonthlyApplications":5200,"sampleSize":32,"concurrency":8,"elapsedMs":446.25,"throughputPerSecond":71.71,"simulatedProxyP95RequestLatencyMs":204.61,"requestStatusCodes":[202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202,202],"replayStatus":202,"reconciliationCases":32,"thresholds":{"simulatedProxyP95RequestLatencyMs":1000},"simulatedProxyPass":true,"actualGates":{"workerRestartAndReclaim":"PENDING_EXTERNAL_REHEARSAL","queueAge":"PENDING_EXTERNAL_REHEARSAL","providerResilience":"PENDING_EXTERNAL_REHEARSAL","hostingCapacity":"PENDING_EXTERNAL_REHEARSAL","restoreIntegrity":"PENDING_EXTERNAL_REHEARSAL","signedUat":"PENDING_EXTERNAL_SIGN_OFF"}}
```

This is a bounded real-app request sample against disposable persistence and the payment simulator. `simulatedProxyP95RequestLatencyMs` is request latency only; it is not queue age, worker restart/reclaim, provider resilience, hosting capacity, or restore evidence. The script deliberately labels every external gate `PENDING` and cannot target production.

## Browser/UI evidence

The Playwright config now starts the actual customer Vite app; no inline HTML or fake browser page remains. A direct static route check succeeded:

```text
Vite: http://127.0.0.1:4178/ ready
Invoke-WebRequest /: Status 200, root element present, app module present
```

The browser runner could not execute in this environment: there is no `%LOCALAPPDATA%\ms-playwright` cache and no system Chrome/Chromium process. The attempted Playwright run started Vite and then stalled at browser launch; it was stopped without installing dependencies. Browser execution is therefore `PENDING_BROWSER_RUNTIME`, not a pass claim.

## Pilot documents and release gates

`platform/docs/pilot/uat-script.md`, `go-no-go-checklist.md`, and `rollback.md` remain unsigned templates. They explicitly keep real-provider, hosting/TLS/secrets, legal/DPC-DPIA/privacy, security, backup/restore, reconciliation, worker restart/reclaim, browser, UAT, signature, contract, ledger/receipt, settlement, and ownership evidence pending or blocked. SAP synchronization remains off pending discovery. No real-provider, hosting, restore, UAT, or production-launch evidence is fabricated.

## Verification

Completed focused checks:

```text
node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts test/e2e/information-request.spec.ts test/e2e/payment-replay.spec.ts test/e2e/recovery-control.spec.ts test/e2e/ownership-transfer.spec.ts  # 5 files / 9 tests passed
node node_modules/tsx/dist/cli.mjs test/load/application-flow.ts                                  # exit 0; simulatedProxyPass=true; p95 204.61 ms
node_modules/.bin/eslint.cmd apps/api/test/task15-controlled-pilot.e2e.test.ts test/e2e test/load/application-flow.ts playwright.config.ts  # exit 0
node_modules/.bin/tsc.cmd --noEmit -p apps/api/tsconfig.json                             # exit 0
node scripts/verify-pilot-gates.mjs --environment test                                      # 10 signed synthetic gates verified
node scripts/verify-workspace.mjs                                                           # workspace configuration verified
```

The broad root `tsc -p tsconfig.base.json --noEmit` remains non-actionable baseline failure: it reports existing JSX/config/package-test errors outside Task 15 (for example `--jsx is not set`, pre-existing db/integrations test typing, and the existing workspace API mismatch). No production module was changed to make that broad command appear green. No `pnpm install` or `pnpm add` was run.

## Self-review

Before handoff, exact `71b0f1dd2a05923886487ae34ff4ec4d8b1a7597..HEAD` changes were reviewed for the rejected standalone harness, literal token-role maps, `setArrears`/`seedActiveContract`, direct workflow-table shortcuts, weak replay assertions, future timestamps, production targets, generated artifacts, and fabricated readiness. The old harness and all stale specs importing it are gone. The only direct SQL writes in the real composition are setup-only product/policy/bootstrap fixtures and the explicitly documented product linkage gap; customer, staff, and provider actions enter real public routes. Production code was not modified.

Commit: recorded in the final handoff (`fix: exercise real controlled pilot boundaries`)
