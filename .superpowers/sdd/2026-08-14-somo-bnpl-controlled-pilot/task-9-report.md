# Task 9 — Controlled financing offers

## Delivery

- Added exact bigint financing schedules for flat-markup and reducing-balance pricing, with calendar-correct monthly/weekly due dates and final-installment residual handling.
- Added versioned product rules, effective dating, maker-checker publishing, exception requests/decisions, immutable accepted offers, idempotent financing commands, audit events, and outbox messages.
- Added the Finance/Compliance worked-example gate. The default production gate has no fixtures and therefore remains fail-closed. No commercial rates, fees, or signed examples were added; the PostgreSQL e2e suite uses an explicitly synthetic, non-production test gate only.
- Added customer offer and staff product/exception screens with explicit gate, expiry, consent, stale-version, and disabled-action states.

## Verification matrix

| Boundary | Command/result |
| --- | --- |
| Domain RED | `pnpm --filter @somo/domain test -- src/financing/financing.test.ts` initially failed because `./schedule.js` did not exist. |
| Domain GREEN | Package-focused command previously passed 25/25; the final direct linked-binary run for `src/financing/financing.test.ts` passed 6/6. |
| API RED | Direct `vitest run test/products.e2e.test.ts` failed at the required real-PostgreSQL guard: `TEST_DATABASE_URL is required for financing API integration tests`; 0 tests ran. |
| API static GREEN | Direct `tsc -p platform/apps/api/tsconfig.json --noEmit` passed. The new e2e file covers effective dating/published immutability, maker-checker, licence and fixture gates, minimum deposit, exception SoD/stale decisions, offer lock/expiry/idempotency, audit, and outbox. |
| DB/domain static GREEN | Direct TypeScript no-emit checks passed for `packages/db` and `packages/domain`. |
| Customer UI GREEN | Focused + existing tests: 16/16 passed; direct customer-web TypeScript check passed. |
| Staff UI GREEN | Focused + existing tests: 6/6 passed; direct staff-web TypeScript check passed. |
| Diff hygiene | `git diff --check` passed; only Git line-ending warnings were emitted. |

## Migration safety

Migration `0010_controlled_financing.sql` is additive. Existing legacy `DECLINING_BALANCE` rows are normalized to the supported `REDUCING_BALANCE` name before the method constraint; existing accepted offers are backfilled to `status = 'ACCEPTED'` before the status constraint, and legacy rows are not required to have newly introduced hash/consent columns. New rule/offer immutability is enforced by database triggers, and all new command/audit/outbox writes are transactionally coupled by the services.

The populated-through-0009 integration fixture now covers preservation of legacy money values, method normalization, accepted-offer status backfill, and nullable canonical hashes. The existing complete-journal test covers fresh application and repeat-safe migration. These real-PostgreSQL checks require `TEST_DATABASE_URL`; this agent worktree does not have that URL configured, so no database was started or mutated as a substitute. Before deployment, run the migration and focused e2e commands against the disposable PostgreSQL database and record their assertion-level GREEN counts here.

## Dependency and self-review

No dependency was added. Financing arithmetic uses bounded bigint rational math, so no Temporal or decimal.js package action was needed. The API workspace link to `@somo/domain` was recorded in the manifest/lock; an offline pnpm linking attempt encountered registry `EACCES` retries and was stopped rather than silently installing or relinking packages.

Self-review found no approved production fixture to transcribe, so production publishing and offer creation remain blocked until signed examples and licence approval are supplied. The API e2e seed now sends one SQL statement per `executeTestSql` call, avoiding pg prepared-statement multi-command failures without weakening production code.

## PostgreSQL verification follow-up

The first controller run after the seed fix reached assertions and reported 5/5 failures at `financing.ts:194`: PostgreSQL `42P18` could not infer the type of the optional `effectiveUntil` parameter. The publish overlap predicate now casts that parameter to `timestamptz` and uses a bounded/open-ended interval expression. The controller must rerun the focused API suite and the populated-0009 migration test with its configured disposable URL to append the assertion-level GREEN counts.

## Reviewer-hardening TDD follow-up

| Boundary | RED | GREEN |
| --- | --- | --- |
| Domain fixture/canonical gate | `vitest run src/financing/fixtures.test.ts`: 2 tests failed before the gate API and canonical serializer existed. | Same direct command: 2/2 passed after strict boolean validation, deep clone/freeze, ordinal canonical JSON, and fail-closed production construction. |
| API DTO/validation | `vitest run src/modules/products/dto.test.ts src/modules/products/service.validation.test.ts`: DTO import failed and 2 validation tests failed at the pre-validation database capability guard. | Same direct command: 3/3 passed after explicit DTO serialization, rate upper bound, disclosure requirement, and fee fail-closed checks. |
| Customer HTTP adapter/state | Focused adapter + OfferPanel run initially had 3 failures (adapter absent; accepted-after-expiry and schedule-length assertions). | `vitest run src/features/offer/offer-panel.test.tsx src/lib/financing-api.test.ts`: 6/6 passed. |
| Staff HTTP adapter/state | Focused adapter + ProductWorkspace run initially had 1 failure (adapter absent; test fixture was 1 pass). | `vitest run src/lib/financing-api.test.ts src/features/products/product-workspace.test.tsx`: 3/3 passed. |

Reviewer-hardening production changes include explicit product/offer/exception DTO mapping on routes, staff list/read endpoints, atomic command reservation with actor binding, product-row publish serialization, transaction-time offer-version locking and exact accepted hash, exact exception rule/field/value binding, rate/database upper bounds, disclosed offer version/hash persistence, and migration `0011_financing_binding.sql`. The fresh/repeat migration journal is now 12 entries, and the populated 0009 fixture applies 0010 then 0011. No dependency or commercial fixture changes were made. The focused real-PostgreSQL API and migration GREEN counts remain controller-owned because `TEST_DATABASE_URL` is not configured in this worktree.

The real-PG suite now also includes concurrent same-window publishes (one winner/one bounded rejection), concurrent offer creation with one atomic idempotency command and replay, and explicit binding fields for exception bypasses. The API TypeScript check including these tests passes; assertion-level results remain pending the controller database run.

## Reviewer-hardening round 2 — trust boundaries

| Boundary | RED evidence | GREEN evidence |
| --- | --- | --- |
| Domain canonical/gate | `vitest run src/financing/fixtures.test.ts` initially failed 2/3: JCS UTF-16 ordering and runtime constructor forgery. | Same focused file passes 4/4: RFC-8785-compatible key ordering vector, non-finite/unsupported rejection, deep freeze, and WeakSet/token gate brand checks. |
| API DTO/validation/exception | DTO test failed on missing explicit rule status/disclosure fields; disclosure validation reached the DB capability guard; strict exception tests reached the DB capability guard (2 failures). | Focused API command passes 6/6 across DTO, product disclosure/rate/fee validation, and strict discriminated exception binding. |
| Customer adapter/UI | Adapter test failed because acceptance omitted affirmative consent; malformed DTO test exposed zero/default behavior. | Customer focused adapter + offer panel passes 7/7; acceptance sends consent plus disclosed version/hash, validates exact money/status/schedule/disclosures, and accepted offers remain accepted after expiry. |
| Staff adapter/UI | Workspace tests failed on structured values, non-pending actions, and non-product-admin publish controls; adapter accepted malformed rule lists. | Staff focused adapter + workspace passes 6/6; list mapping rejects malformed DTOs, publish is PRODUCT_ADMIN-only, only pending exceptions have actions, and values render as JSON. |
| Static verification | — | Direct no-emit TypeScript passes for domain, db, api, customer-web, and staff-web; `git diff --check` passes with only Git line-ending warnings. |

### Persistence and HTTP hardening

- Added additive migration `0012_financing_disclosures.sql` for versioned disclosure content/hash and the exception value-type check. The complete-journal test now expects 13 entries and the populated 0009 fixture applies 0010, 0011, and 0012, asserting legacy disclosure columns remain nullable. Fresh/repeat/populated PostgreSQL execution remains controller-owned because this shell has no `TEST_DATABASE_URL`.
- Rule DTOs now expose explicit persisted-state status and trusted gate status. Product list/read/publish routes require `PRODUCT_ADMIN`; exception routes require configured exception roles, while service-level checker/requester separation remains authoritative.
- Offer creation and acceptance fail closed without actual disclosure content/hash and structured fees. Acceptance locks and re-reads the pending offer version inside the transaction, binds the exact canonical offer hash plus actor/consent/disclosed version/hash in the atomic command payload, and stores audit/outbox evidence.
- Exception requests are a strict amount/frequency/tenure union. Irrelevant fields are rejected, typed values are normalized and persisted, and approved-exception lookup matches rule, field, type, and exact policy/proposed values.
- Customer HTTP DTOs whitelist public terms and exclude fixture hashes, exception IDs, internal rule IDs, raw terms, and bigint values. No commercial fees or signed production fixtures were invented; production fixture gating remains closed.

### Closeout checks

- Final focused non-PG counts: domain 4/4, API 6/6, customer 7/7, staff 6/6.
- Final no-emit TypeScript and package builds passed for domain, db, api, customer-web, and staff-web. API/db/customer/staff lint passed; the pre-existing domain-wide lint command still reports unrelated `schedule.ts` unused-import/prefer-const errors, while the changed fixture files lint clean. Staff's package script references a non-existent `test` directory, so its equivalent `eslint src` check passed.
- `git diff --check` passed with only Git LF/CRLF warnings. Real-PG products/HTTP and fresh/repeat/populated migration execution was not possible here because `TEST_DATABASE_URL` is absent; controller verification is required before deployment.

## Reviewer-hardening round 3 — sealed approval gate and computed status

| Boundary | RED evidence | GREEN evidence |
| --- | --- | --- |
| Domain gate attestation | `vitest run src/financing/fixtures.test.ts` failed 1/5: a frozen-mode override test could define the former public `isProduction` marker. | Same focused file passes 5/5 after private WeakMap mode attestation, frozen gate instances/prototype, and proxy/override rejection. |
| API fee/status boundary | Focused DTO/status command failed 6 tests: malformed/null/unapproved fees were accepted/coerced, missing gate status defaulted closed, and `ruleGateStatus` was not exported. | Same command passes 7/7. Rule/offer DTOs reject invalid fee policies and missing computed status; status closes legacy-null, array, and unapproved fees and opens the valid synthetic test rule. |
| HTTP/customer regression | — | Staff focused financing/product/approval tests pass 10/10; customer financing/offer tests pass 7/7. |
| Static verification | API no-emit check initially exposed only test tuple typing errors, fixed before production verification. | Domain and API `tsc -p tsconfig.json --noEmit` pass; product validation tests pass 5/5; `git diff --check` passes. |

Production build validation now reads the module-private attested mode instead of an overridable property. Publishing reloads the persisted rule and attaches its computed gate status to the return value, replay response, and command/outbox payload. No schema, dependency, or commercial fixture changes were made; real-PostgreSQL and migration checks remain controller-owned because `TEST_DATABASE_URL` is absent in this worktree.
