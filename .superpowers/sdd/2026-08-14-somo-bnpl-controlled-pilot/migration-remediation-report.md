# Populated financial and ownership migration remediation report

Base: `27f9c9506ec50f26d6a9ccd6262ce5d2f58f6d53`

Worktree: `C:\Users\Jordan\Desktop\Somoco BNPL\somo-bnpl-server\somo-bnpl-server\.worktrees\somo-bnpl-controlled-pilot`

Database used for every PostgreSQL-backed command:
`postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`.

No dependency was installed, added, or relinked. No production database,
provider, or GitHub remote was contacted. Database suites were run serially.

## Scope implemented

- Added migration `0034_populated_financial_ownership_remediation.sql` and the
  journal entry for `0034`; migration `0033` is unchanged.
- The migration detects every original payment with more than one historical
  `PAYMENT_REVERSED`/`PAYMENT_REFUNDED` compensation, including provider-payload
  links left unlinked by `0033`. It raises
  `HISTORICAL_MULTIPLE_PAYMENT_COMPENSATIONS_REMEDIATION_REQUIRED` with
  affected original IDs, SQLSTATE `P0001`, and an approved
  adjustment/reconciliation operator hint before any migration DML.
- The migration inspects every pre-existing `ownership_transfer` row in
  `COMPLETED` state. It only backfills a zero-balance, approved transfer with a
  linked vehicle, authoritative latest Somoco registration, applicant-bound
  accepted transfer document, and matching clean/object-bound settlement
  evidence. It atomically transitions contract and vehicle state and appends a
  customer registration while preserving prior history. Other rows fail with
  `LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED`, affected contract
  IDs, SQLSTATE `P0001`, and no partial mutation.
- Hardened both ownership-transfer repository paths to validate authoritative
  state and accepted evidence for an existing `COMPLETED` row, return only for
  coherent state, repair a safely derivable legacy state atomically, and fail
  closed otherwise.

## TDD evidence

### Historical multiple compensations

RED, before the migration existed:

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t 'populated 0034|legacy completed ownership|repairs a legacy|fails closed when a legacy'
```

Result: `3 failed`; the new populated migration cases could not load the
missing `0034` file and the expected stable remediation behavior was absent.

GREEN, after the migration and tests were implemented:

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t 'completes ownership transfer through a locked audited transition|populated 0034|backfills derivable|fails non-derivable'
```

Result: `Test Files 1 passed; Tests 4 passed, 40 skipped`.

The populated ambiguity test proves stable failure, affected-ID detail, the
operator hint, unchanged financial rows, and no migration-side mutation. It
then simulates an approved deterministic binding correction while preserving
both transaction rows and proves rerun succeeds without adding payment,
ledger, or audit rows. The ordinary single-compensation case passes without
adding financial rows. The derivable ownership case passes and direct
reapplication of `0034` remains idempotent.

### Existing COMPLETED ownership runtime

RED, before repository hardening:

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/collections.hardening.test.ts -t 'repairs a legacy completed|fails closed when a legacy'
```

Result: `2 failed`; an incoherent legacy row was returned unchanged and the
derivable legacy state was not repaired.

The exported locked ownership command also had a RED replay assertion: the
new coherent replay expectation resolved with `CONTRACT_NOT_SETTLED` before
the hardened validation path existed.

GREEN:

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/collections.hardening.test.ts -t 'repairs a legacy completed|fails closed when a legacy'
```

Result: `Test Files 1 passed; Tests 2 passed, 14 skipped`.

The locked repository regression is included in the focused DB result above;
the full DB suite also passes its coherent replay assertion.

## Verification evidence

All commands below were executed from the `platform` directory unless noted.

### PostgreSQL and migration regressions

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts
Result: Test Files 1 passed; Tests 44 passed; Duration 69.03s.
```

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/collections.hardening.test.ts
Result: Test Files 1 passed; Tests 16 passed; Duration 47.45s.
```

### Required forward-path regressions

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/assets-contracts.e2e.test.ts
Result: Test Files 1 passed; Tests 11 passed; Duration 30.94s.
```

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts
Result: Test Files 1 passed; Tests 9 passed; Duration 38.60s.
```

### Typecheck, lint, format, and build

```text
node node_modules/typescript/bin/tsc -p packages/db/tsconfig.public-api.json
Result: exit 0.

node node_modules/typescript/bin/tsc -p packages/db/tsconfig.json --noEmit
Result: exit 0.

node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit
Result: exit 0.

node node_modules/eslint/bin/eslint.js packages/db/src/repositories/collections.ts packages/db/src/repositories/contracts.ts packages/db/src/db.integration.test.ts apps/api/test/collections.hardening.test.ts
Result: exit 0.

node node_modules/prettier/bin/prettier.cjs --check packages/db/src/repositories/collections.ts packages/db/src/repositories/contracts.ts packages/db/src/db.integration.test.ts apps/api/test/collections.hardening.test.ts packages/db/drizzle/meta/_journal.json
Result: All matched files use Prettier code style.

node node_modules/typescript/bin/tsc -p packages/db/tsconfig.json
Result: exit 0.

node scripts/build-api.mjs
Result: exit 0.
```

### Workspace and pilot gates

```text
node scripts/verify-workspace.mjs
Result: Workspace configuration verified.

node scripts/verify-pilot-gates.mjs --environment test
Result: pilot gates verified: test (10 signed gates).

node scripts/verify-pilot-gates.mjs
Result: exit 1, PILOT_GATE_EVIDENCE_FILE_REQUIRED (expected fail-closed production behavior).
```

## Self-review against the exact base

The final review target is the exact base commit named above. The change is
limited to the new `0034` migration, its journal entry, the populated DB tests,
the collections hardening tests, and the two ownership repository paths.

- `0033` was not rewritten. The ambiguity check runs before any `0034` DML, so
  a failed migration leaves the transaction unapplied and financial/audit data
  unchanged.
- No payment, ledger, audit, registration, or transfer evidence is deleted or
  rewritten automatically. The only migration ownership writes are the
  bounded authoritative state transition and appended customer registration
  for rows that pass every evidence predicate.
- Ownership history is preserved: the Somoco registration remains and the
  customer registration is appended with accepted evidence binding.
- Runtime repair locks the transfer, contract, vehicle, and authoritative
  latest-registration read in one transaction; coherent replay is idempotent,
  derivable repair is atomic, and contradictory state raises the stable
  remediation error.
- The full DB, collections, assets/contracts, and Task 15 suites pass after
  the final code state. No forward Task 15 behavior or external launch gate was
  relaxed.

External provider, hosting/capacity, legal/privacy, restore, penetration/
security, and staff-signed UAT evidence remain pending. The production pilot
gate verifier correctly remains fail-closed until real signed evidence is
provided.

Exact staged diff review before commit:

````text
git diff --cached --check
Result: no output; exit 0.

git diff --cached --name-status
Result: exactly these seven paths: the remediation report, collections
hardening test, migration 0034, migration journal, DB integration tests,
collections repository, and contracts repository.

## Fix round 1 — independent review remediation

Review base for this round: `fce9a35dadac86f89b71159932d20f5e20f524b1`.
The approved review findings were addressed without changing migration 0033.
Every PostgreSQL command below used only
`postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`; database suites were
serial.

### Strict TDD RED evidence

Applicant binding and migration approval were tested before the production
changes:

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t 'belongs to another person|populated completed ownership transfer is unapproved'
Result: 2 failed; both promises resolved undefined instead of rejecting with
LEGACY_COMPLETED_OWNERSHIP_TRANSFER_REMEDIATION_REQUIRED.
````

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t 'otherwise coherent unapproved ownership transfer replay'
Result: 1 failed; the promise resolved the COMPLETED row with
approvedBy:null instead of rejecting.
```

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/collections.hardening.test.ts -t 'otherwise coherent completed ownership row is unapproved'
Result with the two approval predicates temporarily removed from the
repository: 1 failed; the promise resolved the COMPLETED row with
approvedBy:null instead of rejecting. The predicates were restored before
the GREEN run.
```

### Strict TDD GREEN evidence

Migration 0034 now binds the application and applicant person in its
classification CTE and all three ownership backfill CTEs. Its coherent
classification also requires `approved_by IS NOT NULL`. The exported locked
repository selects and requires the existing transfer approval in both
coherent and derivable branches; the collections repository retains the same
non-null approval predicates.

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t 'belongs to another person|populated completed ownership transfer is unapproved|otherwise coherent unapproved ownership transfer replay'
Result: Test Files 1 passed; Tests 3 passed, 46 skipped.
```

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/collections.hardening.test.ts -t 'otherwise coherent completed ownership row is unapproved'
Result: Test Files 1 passed; Tests 1 passed, 16 skipped.
```

The real Drizzle migration boundary and runtime role proofs pass independently:

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t 'rolls back a failed 0034'
Result: Test Files 1 passed; Tests 1 passed, 48 skipped.
```

The rollback test runs the actual Drizzle migrator through 0033, then runs
0034 through the journal boundary against a populated applicant-mismatched
transfer. It asserts the stable `P0001` error, unchanged contract/vehicle/
registration/transfer/financial snapshots, the original journal rows, 33
applied migrations, and no 0034 hash in `drizzle.__drizzle_migrations`.

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts -t 'repairs ownership transfer under the runtime role'
Result: Test Files 1 passed; Tests 1 passed, 48 skipped.
```

The runtime proof executes the derivable ownership repair after
`SET LOCAL ROLE somo_runtime` and then proves the same role cannot update an
unrelated audit row (`42501`). No migration grant or broad privilege was
needed; existing bounded runtime table grants were sufficient.

### Final verification for this round

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run packages/db/src/db.integration.test.ts
Result: Test Files 1 passed; Tests 49 passed; Duration 70.55s.
```

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/collections.hardening.test.ts
Result: Test Files 1 passed; Tests 17 passed; Duration 46.48s.
```

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/assets-contracts.e2e.test.ts apps/api/test/assets-contracts.http.test.ts
Result: Test Files 2 passed; Tests 15 passed; Duration 33.33s.
```

```text
$env:TEST_DATABASE_URL='postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test'; node node_modules/vitest/vitest.mjs run --config apps/api/vitest.config.ts apps/api/test/task15-controlled-pilot.e2e.test.ts
Result: Test Files 1 passed; Tests 9 passed; Duration 30.15s.
```

Affected static and delivery gates:

```text
node node_modules/typescript/bin/tsc -p packages/db/tsconfig.public-api.json
Result: exit 0.

node node_modules/typescript/bin/tsc -p packages/db/tsconfig.json --noEmit
Result: exit 0.

node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json --noEmit
Result: exit 0.

node node_modules/eslint/bin/eslint.js packages/db/src/db.integration.test.ts packages/db/src/repositories/contracts.ts packages/db/src/repositories/collections.ts apps/api/test/collections.hardening.test.ts
Result: exit 0.

node node_modules/prettier/bin/prettier.cjs --check packages/db/src/db.integration.test.ts packages/db/src/repositories/contracts.ts packages/db/src/repositories/collections.ts apps/api/test/collections.hardening.test.ts
Result: All matched files use Prettier code style.

node node_modules/typescript/bin/tsc -p packages/db/tsconfig.json
Result: exit 0.

node scripts/build-api.mjs
Result: exit 0.

node scripts/verify-workspace.mjs
Result: Workspace configuration verified.

node scripts/verify-pilot-gates.mjs --environment test
Result: pilot gates verified: test (10 signed gates).
```

### Self-review

- The applicant join and `document.person_id = applicant.applicant_person_id`
  predicate are present in classification and each contract, vehicle, and
  registration backfill source. The adversarial accepted/clean other-person
  fixture fails closed before any ownership DML.
- `approved_by IS NOT NULL` is required by migration coherent classification,
  migration backfill, exported repository coherent/derivable validation, and
  collections coherent/derivable validation. The pending exported command now
  requires a non-null approval at the type boundary.
- The real Drizzle journal test proves a failed 0034 transaction does not add
  its journal row or mutate populated state. The runtime-role test proves the
  bounded repair succeeds and unrelated audit mutation remains prohibited.
- No production access, provider access, remote contact, dependency change,
  or broad grant was introduced. The remaining concern is unchanged from the
  prior round: production pilot evidence and external signed UAT gates remain
  pending, so production gate verification must stay fail-closed.

### Post-commit exact-base review

```text
git diff --check fce9a35dadac86f89b71159932d20f5e20f524b1..HEAD
Result: no output; exit 0.

git diff --name-status fce9a35dadac86f89b71159932d20f5e20f524b1..HEAD
Result: exactly the five intended paths in this round: this report, the
collections hardening test, migration 0034, DB integration tests, and the
exported contracts repository.

git status --short
Result: empty after commit.
```

```

```
