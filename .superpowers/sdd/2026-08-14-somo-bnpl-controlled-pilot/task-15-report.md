# Task 15 evidence report

Base: `dbd05ed0f7099a1a66cfcfe01b24197f7ce1c0c3`
Scope: simulator-backed controlled-pilot public-boundary evidence, bounded synthetic load, and pilot operations documents.
Environment: disposable in-process HTTP simulator; no production target, real provider, real hosting, restore rehearsal, penetration test, or staff-signed UAT was used.

## TDD RED/GREEN

The first boundary was the applicant SMS OTP request from a browser form. The intentionally unconnected route returned `501`; the test expected the public success response:

```text
Command: node apps/customer-web/node_modules/@playwright/test/cli.js test --config playwright.config.ts test/e2e/pilot-happy-path.spec.ts
Result: FAIL
Expected: "202"
Received: "501"
```

The route was then wired into the disposable simulator and the complete public-boundary flow was added. Fresh focused GREEN evidence:

```text
Command: node apps/customer-web/node_modules/@playwright/test/cli.js test --config playwright.config.ts test/e2e
Result: 9 passed (2.5s)
```

The browser runtime used the already linked `apps/customer-web/node_modules/@playwright/test` package and installed system Chrome through `channel: "chrome"`. The bundled Playwright browser was not present, so no browser download or dependency installation was performed.

## Executable coverage

- `pilot-happy-path.spec.ts`: applicant OTP/UI boundary; applicant and guarantor independent authentication, NIA/documents/consent/signature; submission; Verification → BSM initial → AGM → CFO → BSM final → MD; approved/accepted offer; signed deposit webhook replay; VIN assignment after reconciled deposit; contract execution/handover/activation; repayment receipts; clean settlement and dual-approved ownership transfer.
- `information-request.spec.ts`: information request/resubmission, NIA outage, malware quarantine, OTP request/verification abuse, wrong-role approval, and licence-disallowed tenure.
- `payment-replay.spec.ts`: payment ledger/receipt/idempotency invariants, unmatched payment reconciliation, cash rejection, and SAP synchronization-off boundary.
- `recovery-control.spec.ts`: separate three-consecutive/three-total signals, no automatic case, role/case-gated location-only tracker access, and prohibited automatic immobilization.
- `ownership-transfer.spec.ts`: outstanding-balance transfer denial, clean repayment, finance/business maker-checker, clean evidence, settlement commit, and final ownership transition.

Customer, staff, and provider actions are sent through the simulator's public HTTP boundaries. No domain tables are written by Task 15 tests. The harness only supplies synthetic identities, deterministic IDs/timestamps, simulator adapter state, and authenticated session tokens.

## Bounded load/resilience evidence

```text
Command: node node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/cli.mjs test/load/application-flow.ts
Output:
{"mode":"disposable-synthetic-simulator","modeledMonthlyApplications":5200,"sampleSize":32,"concurrency":8,"elapsedMs":64.6,"throughputPerSecond":495.32,"p95LatencyMs":25.27,"maxQueueAgeMs":25.27,"replayCount":1,"reconciliationCount":8,"workerRestartReclaimed":true,"providerOutageBoundary":true,"restoredDataIntegrity":"PENDING_EXTERNAL_REHEARSAL","thresholds":{"p95LatencyMs":1000,"maxQueueAgeMs":5000,"monthlyRateModeledAbove":5000},"syntheticPass":true,"externalGates":["DATABASE_RESTORE_AND_INTEGRITY","HOSTING_CAPACITY","SIGNED_UAT"]}
```

This is bounded, deterministic synthetic evidence only. It models 5,200 applications/month, measures a 32-request sample at concurrency 8, sends concurrent signed unmatched webhooks, replays one event to exercise reclaim/idempotency, and crosses a provider outage boundary. It does not claim production capacity, a real worker restart, a real database restore, or restored-data integrity. Those gates remain pending in the load output and the go/no-go checklist.

## Verification

Fresh focused checks completed:

```text
node apps/customer-web/node_modules/@playwright/test/cli.js test --config playwright.config.ts test/e2e   # 9 passed
node node_modules/.pnpm/tsx@4.23.12/node_modules/tsx/dist/cli.mjs test/load/application-flow.ts              # syntheticPass=true
node_modules/.bin/eslint.cmd test/e2e test/load/application-flow.ts playwright.config.ts                  # exit 0
node_modules/.bin/tsc.cmd -p apps/api/tsconfig.json --noEmit                                             # exit 0
node_modules/.bin/tsc.cmd -p apps/customer-web/tsconfig.json --noEmit                                    # exit 0
node_modules/.bin/tsc.cmd -p apps/staff-web/tsconfig.json --noEmit                                       # exit 0
node_modules/.bin/tsc.cmd -p packages/testkit/tsconfig.json --noEmit                                      # exit 0
node_modules/.bin/prettier.cmd --check package.json playwright.config.ts test/e2e test/load/application-flow.ts docs/pilot # exit 0
```

The root `pnpm exec` path attempted during discovery tried to refresh registry metadata and was blocked by the restricted network. No `pnpm install` or `pnpm add` was run. Verification therefore records the direct linked binaries above; the root scripts are present for an environment with the declared dev dependencies linked.

## External release gates and limitations

`platform/docs/pilot/go-no-go-checklist.md` deliberately keeps licence, legal templates, DPC/DPIA, real consent text, NIA/SMS/payment provider evidence, approved hosting/TLS/secrets, backup/restore, security testing, reconciliation sign-off, training, and signed UAT as `PENDING`. SAP synchronization is explicitly off pending discovery. `uat-script.md` is unsigned and `rollback.md` is a rehearsal template. No production launch readiness is claimed.

## Self-review

The exact `BASE..HEAD` review was checked before handoff for direct-table shortcuts, production targets, generated artifacts, weak replay assertions, and fabricated readiness evidence. Task 15 changes are test harness/specs, load evidence, root Playwright/scripts, and pilot documentation only; the prototype and Tasks 1–14 production modules were not modified.
