# Task 14 report — production security and operations controls

Base: `dd59ed822b99b66687e7fdb891debf968825587d`

## Scope

Task 14 adds strict production configuration evidence, privacy lifecycle
service/routes and customer/staff workspaces, correlation-aware redacted
telemetry and health endpoints, local development infrastructure, reverse-proxy
security headers, signed pilot-gate verification, and operations/security
runbooks. Tasks 1–13 files and behavior were preserved.

No database migration was added. Privacy state is held by the injected
`PrivacyService`; production configuration requires an explicit privacy
composition, so the default in-memory development service cannot be mistaken
for production persistence.

## TDD RED/GREEN evidence

- RED: `vitest run test/security/config.test.ts` initially failed because
  simulator and wrapped-simulator adapter names were accepted.
- GREEN: the same focused config suite now passes **2/2**, covering simulator
  adapters, weak secrets, HTTP origins, MFA, public storage, encryption-key
  reference, and stale backup verification.
- RED: `vitest run apps/api/test/privacy.e2e.test.ts` initially failed to import
  the missing privacy service; after the test harness was present, the first
  assertion failed because the safe export shape was not implemented.
- GREEN: privacy lifecycle suite passes **3/3**, covering safe subject export,
  append-only corrections with immutable-evidence refusal, legal holds, and
  approved retention policy enforcement.
- GREEN: telemetry suite passes **2/2**, covering correlation propagation,
  recursive secret/OTP/identity/financial redaction, separate liveness and
  readiness, queue age, reconciliation variance, and provider-failure counts.

## Configuration and gate decisions

- Production `loadConfig` now requires adapter declarations, private object
  storage, an encryption-key reference, and a current backup verification
  timestamp. Simulator/wrapped-simulator names, weak secrets, HTTP origins,
  disabled MFA, public storage, and stale/future backup evidence fail closed.
- `verify:pilot-gates` cryptographically verifies ten current,
  environment-bound, signed records in production. `--environment test` creates
  and verifies ephemeral signed synthetic fixtures only; it does not relax the
  production path.
- No production provider, key, backup, hosting, or legal fixture was added.

## Verification evidence

Fresh commands from this worktree:

- `vitest run test/security/config.test.ts apps/api/test/privacy.e2e.test.ts packages/integrations/src/telemetry.test.ts apps/api/test/bootstrap.test.ts apps/api/test/production-payment-composition.test.ts apps/worker/test/send-reminders.test.ts` — **6 files, 15 tests passed**.
- Affected TypeScript checks for API, integrations, worker, customer web, and
  staff web — **exit 0**.
- Affected ESLint — **exit 0**.
- Affected Prettier check — **exit 0**.
- `node scripts/verify-pilot-gates.mjs --environment test` — **10 signed gates
  verified**.
- API/integrations/worker TypeScript builds — **exit 0**.
- Customer-web and staff-web Vite production builds — **exit 0**.
- `git diff --check` — **exit 0**.

The linked worker esbuild wrapper was also attempted from the package worktree,
but the sandbox denied its pnpm virtual-store parent resolution (`Cannot read
directory "../../../../../../../../..": Access is denied`). The worker
TypeScript build passed; no source failure was observed in that blocked bundle
invocation.

## Security self-review

The exact `BASE..HEAD` scope was reviewed for hard-coded production secrets,
PII/OTP leakage, mutable evidence, public health internals, fail-open adapter or
gate verification, and misleading launch claims. Synthetic values are confined
to explicit test/local-development paths. Telemetry recursively redacts secret,
OTP, identity, and financial keys. Health endpoints return only status. Runbook
material preserves location-only tracking and manual recovery decisions.

## Residual external launch gates

This commit does not claim real production launch readiness. Signed and approved
Bank of Ghana/licence, legal contract/disclosure, DPC registration/DPIA/privacy,
real NIA/SMS/payment adapters, approved hosting/TLS/secrets/object storage,
finance calculation, encrypted backup/restore rehearsal, independent security
testing, and operational ownership evidence remain required release gates.

## Review fix round (3278a98..fix commit)

The independent review findings were addressed without widening the Task 14
scope:

- Every production `AppConfig`, including direct object construction, now
  requires non-simulator NIA/SMS/payment declarations, private object storage,
  key reference, and current backup verification. The caller-set
  `productionControlsConfigured` bypass was removed. Production composition
  cannot fall back to the in-memory privacy service.
- Bootstrap verifies the same signed, current, environment-bound ten-gate
  contract before build/listen. Synthetic signed evidence is available only
  when the verifier is explicitly run in test mode.
- API readiness probes PostgreSQL with `select 1`, starts required production
  dependency statuses DOWN until explicit checks pass, and exposes only the
  public status. Worker startup probes PostgreSQL and fails with
  `WORKER_DATABASE_NOT_READY` before loading handlers or dispatching work.
- Staff privacy listing and internal request lookup require a compliance role;
  terminal requests cannot be reviewed, corrected, restricted, or reopened.
  Retention policy versions are immutable and identical approvals are
  idempotent. Retention marks subject state and exports only an anonymized
  marker while retaining internal correction/restriction evidence.
- API request hooks enter the telemetry and durable outbox correlation
  contexts. `enqueueOutbox` carries the correlation ID into object payloads;
  worker dispatch reuses it rather than creating a new trace.
- Local compose ports are bound to `127.0.0.1`.

Fix-round TDD evidence:

- RED: `vitest run apps/api/test/task14-security-gaps.test.ts packages/db/src/outbox-context.test.ts`
  failed **8/8** adversarial API assertions and could not import the missing
  outbox-context module before implementation.
- GREEN: the adversarial API/worker/db suites pass **13/13**; the prior focused
  suites plus the new suites pass **9 files, 28 tests**.

Fresh fix-round verification:

- API, worker, DB, integrations, customer-web, and staff-web TypeScript
  checks — **exit 0**.
- API and worker TypeScript builds plus integrations build — **exit 0**.
- Affected ESLint — **exit 0**.
- Affected Prettier check — **exit 0**.
- `node scripts/verify-pilot-gates.mjs --environment test` — **10 signed gates
  verified**.
- `git diff --check` — **exit 0**.

The earlier worker esbuild wrapper limitation remains documented above; it was
an environment sandbox path-resolution failure, while the worker TypeScript
build and focused worker tests pass. This fix round likewise does not claim
real production launch readiness; signed provider, legal/privacy, hosting,
restore, independent security, and operational release gates remain external
blockers.
