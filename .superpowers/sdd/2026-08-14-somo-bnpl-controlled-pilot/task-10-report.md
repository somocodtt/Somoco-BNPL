# Task 10 — Asset contract and handover controls

## Delivery

- Added model-first asset registration and assignment controls. A vehicle can be assigned only after MD-approved application state, a current accepted locked offer, reconciled deposit evidence, matching model, and current registration and insurance. VIN, chassis, engine/motor, and tracker identifiers are required or rejected; duplicate identifiers fail closed.
- Added immutable assignment/audit/outbox evidence, explicit reassignment approval/reason/versioning, append-only contract execution evidence, clean malware-scanned executed-document binding, handover checklist/customer acknowledgement, idempotent activation, and Somoco ownership retention.
- Added location-only tracker access restricted to recovery staff and audited on every access. Customer DTOs do not expose VIN, tracker identifiers, document hashes, or internal contract references.
- Added runtime-attested legal-template composition. No approved legal template was present in the worktree, so production contract generation fails closed; synthetic templates are branded test-only and never accepted by production mode.
- Added staff asset/contract controls and customer contract/handover state with explicit loading, empty, error, stale, blocked, unsigned-preview, execution, handover, and active-repayment states.

## TDD and boundary verification

| Boundary                 | RED evidence                                                                                                                                | GREEN evidence                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API real-PG              | Focused direct Vitest run initially failed before implementation with `Cannot find module '../src/modules/assets/service.js'`; 0 tests ran. | From `platform/apps/api` with `TEST_DATABASE_URL=postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`, `vitest run test/assets-contracts.e2e.test.ts` — 1 file, 6/6 passed. Coverage includes identifier uniqueness, assignment gates, reassignment approval/version, tracker restriction/audit, legal-template/execution evidence, handover, activation idempotency, ownership, audit, and outbox. |
| API HTTP                 | New HTTP boundary was authored against the real app route composition.                                                                      | Same package-cwd run of `vitest run -c vitest.config.ts test/assets-contracts.http.test.ts` — 1 file, 2/2 passed: unauthenticated/schema-invalid requests fail closed and authorized inventory staff receive a JSON-safe inventory DTO.                                                                                                                                                               |
| Staff UI/HTTP adapter    | New asset/contract screen and adapter were added before final UI verification.                                                              | Staff app full Vitest with `vite.config.ts` — 4 files, 14/14 passed. Staff asset/contract focused tests 3/3 and adapter tests 3/3 passed. Staff TypeScript no-emit passed.                                                                                                                                                                                                                            |
| Customer UI/HTTP adapter | New customer contract state and safe DTO adapter were added before final UI verification.                                                   | Customer app full Vitest with `vite.config.ts` — 4 files, 24/24 passed. Customer contract focused tests 3/3 and adapter tests 3/3 passed. Customer TypeScript no-emit passed.                                                                                                                                                                                                                         |
| Static checks            | —                                                                                                                                           | No-emit TypeScript passed for `packages/db`, DB public API, `apps/api`, `apps/staff-web`, and `apps/customer-web`; `git diff --check` passed.                                                                                                                                                                                                                                                         |

## Migration safety

Migration `0013_asset_contract_handover.sql` is additive. Existing vehicle/assignment/contract rows retain nullable legacy fields where evidence was not available; new production writes require the relevant gates. It adds identifier/check constraints, assignment evidence/version columns, versioned template metadata, append-only contract execution, handover fields, reconciled deposit evidence, and idempotency command storage. Database triggers reject mutation of approved template rows and contract execution rows.

The fresh/repeat journal assertion was run against real PostgreSQL and passed (`1 passed | 29 skipped` when targeted). The populated legacy migration assertion through 0013 was also run against real PostgreSQL and passed (`2 passed | 28 skipped` when targeted). A broad DB-file run from a controller-overlapping shell produced shared disposable-schema reset races; those discarded results are not treated as implementation evidence. Re-run the complete DB suite sequentially from the controller-owned package cwd before deployment.

## Dependency and legal/commercial controls

No dependency was installed, added, or relinked. All checks used direct linked binaries from the package cwd. No legal/commercial template, rate, fee, signed example, ownership transfer, or non-location tracker behavior was invented. Production contract generation remains blocked until runtime composition injects an externally attested approved template.

## Closeout

- Final intended commit: `feat: add asset contract and handover controls`.
- Parent/controller should run the final complete sequential database check, verify the clean commit SHA, and cherry-pick this commit if the worktree is not shared directly.

## Fix round 1 — hardening evidence

- Baseline RED was the focused real-PG forgery case: `1 failed / 5 passed`; a branded production attestation could reference a TEST template row. Production generation now requires the module-private attestation brand and exact persisted approved template ID, version, hashes, content, approver, and effective window. No production legal template is fabricated or defaulted.
- Customer acknowledgement is applicant-session/person bound, append-only, replay-bound to actor and payload, and requires the exact versioned checklist item IDs/results. Staff completion requires that acknowledgement, a separate staff witness, an exact configured head-office ID/location, and a clean accepted PDF executed-contract document FK-bound to `privacy.document`.
- Generated contracts bind the vehicle unit permanently; reassignment is denied after generation. Assignment and activation compare the contract-bound vehicle, strict locked schedules are validated without filtering or invented due dates, and assignment transitions `AWAITING_ASSET_ASSIGNMENT` to `AWAITING_EXECUTION` atomically.
- Registration, insurance, and tracker writes now reserve durable actor/payload idempotency commands before mutation, use optimistic vehicle versions, and atomically write audit/outbox effects. Inventory DTOs and recovery access expose no tracker identifiers or device controls; recovery returns only location deep-link/last-known access.

### Fix-round verification

| Boundary | Result |
| --- | --- |
| API real-PG contracts/assets | 9/9 passed |
| HTTP route boundary | 3/3 passed |
| Customer UI focused | 7/7 passed |
| Staff UI focused | 4/4 passed in the final focused file; prior focused adapter/UI set was 7/7 |
| TypeScript no-emit | DB, API, customer web, and staff web passed |
| Migration fresh/repeat and populated upgrade through 0014 | 12/12 selected DB integration tests passed, including journal repeat and populated migration |
| Diff hygiene | `git diff --check` passed |

The unfiltered DB integration file still contains eight pre-existing financing fixture failures because its legacy fixture inserts `DECLINING_BALANCE`, which the current `financing_rule_method_allowed` constraint rejects; the migration and Task 10 DB checks above pass sequentially against PostgreSQL.
