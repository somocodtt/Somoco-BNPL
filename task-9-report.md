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

Migration `0010_controlled_financing.sql` is additive. Existing accepted offers are backfilled to `status = 'ACCEPTED'` before the status constraint; the legacy rows are not required to have newly introduced hash/consent columns. New rule/offer immutability is enforced by database triggers, and all new command/audit/outbox writes are transactionally coupled by the services.

The migration and real-PG e2e suite could not be executed in this worktree because `TEST_DATABASE_URL` is not configured. No database was started or mutated as a substitute. Before deployment, run the migration and the focused e2e command against a disposable PostgreSQL database and inspect the resulting schema and trigger behavior.

## Dependency and self-review

No dependency was added. Financing arithmetic uses bounded bigint rational math, so no Temporal or decimal.js package action was needed. The API workspace link to `@somo/domain` was recorded in the manifest/lock; an offline pnpm linking attempt encountered registry `EACCES` retries and was stopped rather than silently installing or relinking packages.

Self-review found no approved production fixture to transcribe, so production publishing and offer creation remain blocked until signed examples and licence approval are supplied. The only unverified boundary is the real PostgreSQL migration/e2e execution noted above.
