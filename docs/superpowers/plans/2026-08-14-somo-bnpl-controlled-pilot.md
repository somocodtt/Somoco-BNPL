# Somo BNPL Controlled Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a secure, provider-neutral Somo BNPL platform core that is ready for a 25–50-application controlled pilot once Somoco supplies and validates its NIA, SMS, payment, legal-template, and hosting artifacts.

**Architecture:** Create a new pnpm TypeScript workspace under platform/ while preserving the current prototype unchanged. Use two React PWAs, a Fastify API, a PostgreSQL-backed worker, pure domain packages, Drizzle repositories, encrypted S3-compatible document storage, and transactional inbox/outbox records. Provider-specific code is isolated behind canonical adapters so real provider subplans can be written from supplied documentation without changing the domain.

**Tech Stack:** Node.js 22+, TypeScript, pnpm workspaces, Fastify, React, Vite, Zod, Drizzle ORM, PostgreSQL, decimal.js, Vitest, Testing Library, Playwright, S3-compatible object storage, ClamAV-compatible malware scanning, OpenTelemetry, ESLint, and Prettier.

## Global Constraints

- Preserve server.js, public/index.html, data/store.json, Dockerfile, and docker-compose.yml as the read-only prototype baseline during the pilot build.
- New production code lives under platform/.
- Individual customers only; no business or fleet onboarding.
- Customer and guarantor authenticate independently using phone-number SMS OTP.
- NIA verification is mandatory for both parties before application submission.
- The approval order is Verification Officer, BSM initial, AGM, CFO, BSM final, MD.
- Model selection occurs before approval; chassis or VIN assignment occurs only after MD approval and reconciled deposit.
- Deposits and repayments use Somoco USSD and Mobile Money only; cash is not represented.
- Repayment frequency is weekly or monthly.
- Tenures are 6, 8, 12, 24, 36, and 48 months, with each tenure disabled until licence approval is evidenced.
- Flat-markup and reducing-balance methods remain disabled until Finance-approved worked examples are encoded as tests.
- Somoco retains vehicle registration, insurance, and ownership through final settlement.
- No automatic approval, recovery, seizure, immobilization, or ownership transfer.
- Three consecutive missed installments and three total unpaid installments are separate escalation signals.
- All external writes are idempotent and auditable.
- All money is GHS integer minor units at persistence and API boundaries; no binary floating-point money.
- Real personal data is prohibited from development and automated-test environments.
- No real pilot traffic starts until every launch gate in the approved design is evidenced.

## Scope decomposition

This plan covers the provider-neutral controlled-pilot core and simulator-backed acceptance testing. It deliberately leaves these independent follow-on plans:

1. NIA and SMS production connectors, written after provider documents and sandbox access arrive.
2. Somoco payment production connector and settlement mapping, written after webhook and reconciliation specifications arrive.
3. Approved-hosting deployment, backup, monitoring, and recovery runbook, written after infrastructure specifications arrive.
4. SAP direct or middleware integration, written after SAP discovery and source-of-truth approval.
5. Read-only tracker API integration.
6. Credit-bureau API integration.
7. Bulk Excel and paper migration execution.
8. Wider public rollout and post-pilot hardening.

The core can be implemented and fully tested with deterministic simulators. A real pilot cannot start with simulators.

## File structure

Create this structure:

~~~text
platform/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  eslint.config.mjs
  prettier.config.mjs
  vitest.workspace.ts
  .env.example
  apps/
    api/
      package.json
      src/
        main.ts
        app.ts
        config.ts
        plugins/
          auth.ts
          errors.ts
          request-context.ts
          security.ts
        modules/
          access/
          applications/
          approvals/
          assets/
          collections/
          contracts/
          documents/
          identity/
          integrations/
          migration/
          notifications/
          payments/
          products/
          reports/
      test/
    worker/
      package.json
      src/main.ts
      src/jobs/
    customer-web/
      package.json
      src/
        app/
        features/
        lib/
        service-worker.ts
      public/manifest.webmanifest
    staff-web/
      package.json
      src/
        app/
        features/
        lib/
  packages/
    contracts/
      package.json
      src/
    domain/
      package.json
      src/
    db/
      package.json
      drizzle.config.ts
      migrations/
      src/
        client.ts
        schema/
        repositories/
    integrations/
      package.json
      src/
    testkit/
      package.json
      src/
  infra/
    compose.dev.yml
    clamav/
    reverse-proxy/
  scripts/
    verify-workspace.mjs
    verify-pilot-gates.mjs
~~~

Responsibilities:

- packages/contracts owns Zod DTOs and API-safe serialized types.
- packages/domain owns pure money, schedule, state-machine, authorization-policy, and arrears logic.
- packages/db owns schema, migrations, repositories, transactions, inbox, outbox, and audit persistence.
- packages/integrations owns provider ports, canonical messages, signature verification, and simulator adapters.
- packages/testkit owns deterministic clocks, IDs, provider fakes, database reset, and test builders.
- apps/api owns HTTP transport and application-service orchestration.
- apps/worker owns durable background dispatch and scheduled jobs.
- apps/customer-web owns applicant and guarantor experiences.
- apps/staff-web owns all staff queues and operations.

Command convention:

- All paths in this plan are relative to the repository root.
- Run pnpm commands from platform/.
- Run git add and git commit commands from the repository root.
- Commit platform/pnpm-lock.yaml whenever dependency resolution changes.
- Dependency commands below intentionally omit versions; pnpm records the resolved versions in package.json and pins the exact graph in pnpm-lock.yaml during execution.

Package manifest convention:

- Every package uses type: module and private: true.
- Library packages expose dist/index.js and dist/index.d.ts and use tsc for build.
- API and worker packages use tsc for build and node dist/main.js for start.
- Web packages use Vite for build and preview.
- Every package defines lint as eslint src plus its test directories, typecheck as tsc --noEmit, and test as vitest run.
- Internal dependencies use workspace:* ranges.
- API, worker, and web tsconfig files extend ../../tsconfig.base.json; package tsconfig files extend the same file from their relative location.

Use this library manifest shape, changing only name and dependencies:

~~~json
{
  "name": "@somo/domain",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "lint": "eslint src",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  }
}
~~~

Use this web-app script block:

~~~json
{
  "scripts": {
    "build": "vite build",
    "lint": "eslint src",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "e2e": "playwright test"
  }
}
~~~

Install dependencies in the task that first uses them:

~~~powershell
# Task 1, from platform/
pnpm add -Dw @eslint/js eslint prettier typescript typescript-eslint vitest

# Task 2
pnpm --filter @somo/contracts add zod

# Task 3
pnpm --filter @somo/db add drizzle-orm pg
pnpm --filter @somo/db add -D drizzle-kit @types/pg

# Task 4
pnpm --filter @somo/api add fastify @fastify/cookie @fastify/cors @fastify/csrf-protection @fastify/helmet @fastify/rate-limit argon2

# Task 6
pnpm --filter @somo/integrations add @aws-sdk/client-s3 file-type

# Task 7 and Task 8
pnpm --filter @somo/customer-web add react react-dom react-router-dom zod
pnpm --filter @somo/customer-web add -D vite @vitejs/plugin-react @testing-library/react @testing-library/user-event jsdom
pnpm --filter @somo/staff-web add react react-dom react-router-dom zod
pnpm --filter @somo/staff-web add -D vite @vitejs/plugin-react @testing-library/react @testing-library/user-event jsdom

# Task 9
pnpm --filter @somo/domain add decimal.js @js-temporal/polyfill

# Task 13
pnpm --filter @somo/api add exceljs

# Task 14
pnpm --filter @somo/api add @opentelemetry/api
pnpm --filter @somo/worker add @opentelemetry/api

# Task 15
pnpm add -Dw @playwright/test tsx
~~~

---

### Task 1: Initialize source control and the production workspace

**Files:**
- Modify: .gitignore
- Create: platform/package.json
- Create: platform/pnpm-workspace.yaml
- Create: platform/tsconfig.base.json
- Create: platform/eslint.config.mjs
- Create: platform/prettier.config.mjs
- Create: platform/vitest.workspace.ts
- Create: platform/.env.example
- Create: platform/scripts/verify-workspace.mjs
- Create: platform/packages/domain/package.json
- Create: platform/packages/domain/src/workspace.test.ts

**Interfaces:**
- Consumes: Node.js 22.14.0 and pnpm 11.19.0 available on the workstation.
- Produces: workspace commands pnpm lint, pnpm typecheck, pnpm test, and pnpm build; package name @somo/domain.

- [ ] **Step 1: Initialize Git without changing prototype files**

Run from the repository root:

~~~powershell
git init
git status --short
~~~

Expected: a new repository with existing prototype and docs shown as untracked. Do not move or delete them.

- [ ] **Step 2: Create the workspace manifests**

Use this root manifest:

~~~json
{
  "name": "somo-bnpl-platform",
  "private": true,
  "packageManager": "pnpm@11.19.0",
  "engines": { "node": ">=22.14.0" },
  "scripts": {
    "build": "pnpm -r build",
    "lint": "pnpm -r lint",
    "typecheck": "pnpm -r typecheck",
    "test": "pnpm -r test",
    "verify": "pnpm lint && pnpm typecheck && pnpm test && pnpm build",
    "verify:workspace": "node scripts/verify-workspace.mjs"
  }
}
~~~

Use this workspace file:

~~~yaml
packages:
  - apps/*
  - packages/*
~~~

The base TypeScript configuration must enable strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride, useUnknownInCatchVariables, and ES module output.

Expand the repository .gitignore with:

~~~gitignore
node_modules/
platform/node_modules/
platform/**/dist/
platform/**/coverage/
platform/**/.env
platform/**/.env.*
!platform/**/.env.example
platform/playwright-report/
platform/test-results/
data/store.json
data/*.tmp
~~~

Do not ignore platform/pnpm-lock.yaml.

- [ ] **Step 3: Write a failing workspace-boundary test**

Create platform/packages/domain/src/workspace.test.ts:

~~~typescript
import { describe, expect, it } from "vitest";
import { packageBoundary } from "./workspace.js";

describe("domain package boundary", () => {
  it("contains no framework dependency", () => {
    expect(packageBoundary()).toEqual({ frameworkFree: true });
  });
});
~~~

- [ ] **Step 4: Run the test and verify failure**

Run:

~~~powershell
Set-Location platform
pnpm install
pnpm --filter @somo/domain test -- src/workspace.test.ts
~~~

Expected: FAIL because src/workspace.ts does not exist.

- [ ] **Step 5: Add the minimal domain package implementation**

Create platform/packages/domain/src/workspace.ts:

~~~typescript
export function packageBoundary(): { frameworkFree: true } {
  return { frameworkFree: true };
}
~~~

Add scripts to @somo/domain for test, typecheck, lint, and build.

- [ ] **Step 6: Verify workspace commands**

Run:

~~~powershell
pnpm verify:workspace
pnpm verify
~~~

Expected: both commands exit 0 and the prototype files remain unchanged.

- [ ] **Step 7: Commit**

~~~powershell
git add .gitignore platform
git commit -m "build: initialize production platform workspace"
~~~

### Task 2: Define shared contracts and pure domain primitives

**Files:**
- Create: platform/packages/contracts/package.json
- Create: platform/packages/contracts/src/common.ts
- Create: platform/packages/contracts/src/applications.ts
- Create: platform/packages/contracts/src/payments.ts
- Create: platform/packages/contracts/src/index.ts
- Create: platform/packages/contracts/src/contracts.test.ts
- Create: platform/packages/domain/src/money.ts
- Create: platform/packages/domain/src/money.test.ts
- Create: platform/packages/domain/src/application-state.ts
- Create: platform/packages/domain/src/application-state.test.ts
- Create: platform/packages/domain/src/clock.ts
- Create: platform/packages/domain/src/index.ts

**Interfaces:**
- Consumes: @somo/domain workspace from Task 1.
- Produces: Money, MoneyDto, ApplicationStatus, ApprovalStage, assertTransition, Clock, and shared Zod DTO schemas.

Define these stable types:

~~~typescript
export type Currency = "GHS";
export type Money = Readonly<{ currency: Currency; minorUnits: bigint }>;
export type MoneyDto = Readonly<{ currency: Currency; minorUnits: string }>;

export type ApplicationStatus =
  | "DRAFT"
  | "AWAITING_GUARANTOR"
  | "READY_TO_SUBMIT"
  | "VERIFICATION_REVIEW"
  | "BSM_INITIAL_REVIEW"
  | "AGM_REVIEW"
  | "CFO_REVIEW"
  | "BSM_FINAL_REVIEW"
  | "MD_REVIEW"
  | "INFORMATION_REQUESTED"
  | "REJECTED"
  | "APPROVED"
  | "AWAITING_DEPOSIT"
  | "AWAITING_ASSET_ASSIGNMENT"
  | "AWAITING_EXECUTION"
  | "ACTIVE"
  | "SETTLED"
  | "RECOVERY";

export type ApprovalStage =
  | "VERIFICATION"
  | "BSM_INITIAL"
  | "AGM"
  | "CFO"
  | "BSM_FINAL"
  | "MD";
~~~

- [ ] **Step 1: Write money serialization and arithmetic tests**

Test GHS-only construction, negative-value rejection, exact addition, DTO string serialization, and conversion back to bigint.

~~~typescript
it("adds minor units without floating point", () => {
  expect(addMoney(ghs(10_005n), ghs(995n))).toEqual(ghs(11_000n));
});

it("serializes bigint as a decimal string", () => {
  expect(toMoneyDto(ghs(12_345n))).toEqual({
    currency: "GHS",
    minorUnits: "12345"
  });
});
~~~

- [ ] **Step 2: Run the money tests and verify failure**

Run:

~~~powershell
pnpm --filter @somo/domain test -- src/money.test.ts
~~~

Expected: FAIL because money.ts is absent.

- [ ] **Step 3: Implement the money primitives**

Export ghs, addMoney, subtractMoney, compareMoney, toMoneyDto, and fromMoneyDto. Reject mixed currencies and values outside signed 64-bit storage range.

- [ ] **Step 4: Write the application transition tests**

Include positive tests for the approved sequence and negative tests for stage skipping, VIN assignment before deposit, activation before physical execution, and settlement with an outstanding balance.

~~~typescript
it("rejects skipping from verification to CFO", () => {
  expect(() =>
    assertTransition("VERIFICATION_REVIEW", "CFO_REVIEW")
  ).toThrowError("APPLICATION_TRANSITION_NOT_ALLOWED");
});
~~~

- [ ] **Step 5: Run transition tests and verify failure**

Run:

~~~powershell
pnpm --filter @somo/domain test -- src/application-state.test.ts
~~~

Expected: FAIL because assertTransition is absent.

- [ ] **Step 6: Implement the explicit transition table**

Do not infer order from array indexes. Export a read-only map of permitted status transitions and assertTransition(from, to).

- [ ] **Step 7: Add Zod transport schemas**

Define PhoneNumber as E.164 Ghana format, GhanaCardNumber, UUID strings, MoneyDto, pagination, problem-detail errors, application-create input, guarantor invitation, and canonical payment event. Refine all string lengths and reject unknown fields on privileged inputs.

- [ ] **Step 8: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/domain test
pnpm --filter @somo/contracts test
pnpm typecheck
git add platform/packages/domain platform/packages/contracts
git commit -m "feat: add domain primitives and shared contracts"
~~~

### Task 3: Create the PostgreSQL schema, transactions, audit, inbox, and outbox

**Files:**
- Create: platform/packages/db/package.json
- Create: platform/packages/db/drizzle.config.ts
- Create: platform/packages/db/src/client.ts
- Create: platform/packages/db/src/transaction.ts
- Create: platform/packages/db/src/schema/access.ts
- Create: platform/packages/db/src/schema/applications.ts
- Create: platform/packages/db/src/schema/products.ts
- Create: platform/packages/db/src/schema/assets.ts
- Create: platform/packages/db/src/schema/contracts.ts
- Create: platform/packages/db/src/schema/payments.ts
- Create: platform/packages/db/src/schema/audit.ts
- Create: platform/packages/db/src/schema/privacy.ts
- Create: platform/packages/db/src/schema/integrations.ts
- Create: platform/packages/db/src/schema/migration.ts
- Create: platform/packages/db/src/schema/index.ts
- Create: platform/packages/db/src/repositories/
- Create: platform/packages/db/src/outbox.ts
- Create: platform/packages/db/src/inbox.ts
- Create: platform/packages/db/src/db.integration.test.ts
- Create: platform/packages/testkit/package.json
- Create: platform/packages/testkit/src/database.ts
- Create: platform/packages/testkit/src/builders.ts

**Interfaces:**
- Consumes: MoneyDto and domain statuses from Task 2; TEST_DATABASE_URL.
- Produces: Database, withTransaction, repositories, appendAuditEvent, enqueueOutbox, claimOutboxBatch, receiveInboxMessage, and resetTestDatabase.

Required database rules:

- UUID primary keys.
- timestamptz for events; date for contractual due dates.
- bigint for GHS minor units.
- numeric integer basis points for rates.
- unique provider plus provider_event_id for incoming integration deduplication.
- unique provider plus provider_transaction_id for payments.
- append-only audit_event and ledger_entry tables enforced by database privilege and repository API.
- optimistic version columns on mutable aggregates.
- foreign keys and check constraints for nonnegative money and allowed enums.

- [ ] **Step 1: Create a failing schema integration test**

The test must migrate an empty database and assert that inserting an application with a missing person fails, duplicate inbox events return the existing record, and a business transaction can persist aggregate change, audit, and outbox together.

~~~typescript
it("commits aggregate, audit, and outbox atomically", async () => {
  await withTransaction(db, async (tx) => {
    await applicationRepo(tx).insert(applicationBuilder());
    await appendAuditEvent(tx, auditBuilder());
    await enqueueOutbox(tx, outboxBuilder());
  });
  expect(await countRows(db, "application")).toBe(1);
  expect(await countRows(db, "audit_event")).toBe(1);
  expect(await countRows(db, "outbox_message")).toBe(1);
});
~~~

- [ ] **Step 2: Run and verify failure**

Run:

~~~powershell
pnpm --filter @somo/db test -- src/db.integration.test.ts
~~~

Expected: FAIL because schema and migration do not exist. If TEST_DATABASE_URL is absent, stop and obtain a disposable PostgreSQL database; do not replace this test with an in-memory SQL emulator.

- [ ] **Step 3: Implement schema modules and first migration**

Keep each schema file below 300 lines by splitting tables by business module. Generate and inspect SQL before applying it.

- [ ] **Step 4: Implement transaction, repository, audit, inbox, and outbox APIs**

Use this outbox shape:

~~~typescript
export interface OutboxMessage {
  id: string;
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: unknown;
  occurredAt: Date;
  attempts: number;
}
~~~

claimOutboxBatch must use row locking with skip-locked semantics so two workers cannot dispatch the same claim concurrently.

- [ ] **Step 5: Prove rollback behavior**

Add a test that throws after enqueueOutbox and asserts zero aggregate, audit, and outbox rows were committed.

- [ ] **Step 6: Verify migration and tests**

Run:

~~~powershell
pnpm --filter @somo/db db:migrate:test
pnpm --filter @somo/db test
pnpm typecheck
~~~

Expected: migration exits 0 and all database tests pass.

- [ ] **Step 7: Commit**

~~~powershell
git add platform/packages/db platform/packages/testkit
git commit -m "feat: add transactional persistence and outbox"
~~~

### Task 4: Build the secured API shell, staff authentication, and RBAC

**Files:**
- Create: platform/apps/api/package.json
- Create: platform/apps/api/src/config.ts
- Create: platform/apps/api/src/app.ts
- Create: platform/apps/api/src/main.ts
- Create: platform/apps/api/src/plugins/errors.ts
- Create: platform/apps/api/src/plugins/request-context.ts
- Create: platform/apps/api/src/plugins/security.ts
- Create: platform/apps/api/src/plugins/auth.ts
- Create: platform/apps/api/src/modules/access/actions.ts
- Create: platform/apps/api/src/modules/access/policy.ts
- Create: platform/apps/api/src/modules/access/service.ts
- Create: platform/apps/api/src/modules/access/routes.ts
- Create: platform/apps/api/test/access.e2e.test.ts

**Interfaces:**
- Consumes: Database and access tables from Task 3.
- Produces: buildApp, StaffPrincipal, CustomerPrincipal, authorize, POST /v1/staff/sessions, DELETE /v1/staff/sessions/current, and staff-user administration routes.

Define:

~~~typescript
export interface StaffPrincipal {
  kind: "staff";
  staffUserId: string;
  roles: readonly StaffRole[];
  sessionId: string;
}

export type StaffRole =
  | "VERIFICATION_OFFICER"
  | "BSM"
  | "AGM"
  | "CFO"
  | "MD"
  | "PRODUCT_ADMIN"
  | "INVENTORY_OFFICER"
  | "FINANCE_OFFICER"
  | "RECOVERY_OFFICER"
  | "COMPLIANCE_AUDITOR"
  | "CUSTOMER_SUPPORT"
  | "SYSTEM_ADMIN";
~~~

- [ ] **Step 1: Write failing API security tests**

Test secure headers, request correlation ID, JSON problem response, unknown-field rejection, no stack trace, and rate limiting.

- [ ] **Step 2: Run and verify failure**

Run:

~~~powershell
pnpm --filter @somo/api test -- test/access.e2e.test.ts
~~~

Expected: FAIL because buildApp is absent.

- [ ] **Step 3: Implement the Fastify shell**

Use centralized config validation. Refuse startup if production secrets, database URL, allowed origins, or cookie settings are absent. Register secure headers, body limits, request IDs, structured redacting logs, CORS allowlist, and problem-detail errors.

- [ ] **Step 4: Write failing RBAC and separation tests**

Include:

~~~typescript
it("prevents a system administrator from approving a loan", () => {
  expect(() =>
    authorize(systemAdminPrincipal(), "application.approve.md")
  ).toThrowError("FORBIDDEN");
});

it("allows the MD role to make the MD decision", () => {
  expect(() => authorize(mdPrincipal(), "application.approve.md")).not.toThrow();
});
~~~

- [ ] **Step 5: Implement explicit action-to-role policy**

Do not infer permissions from route names. Audit every privileged success and denial that indicates misuse. Technical administrators can manage accounts but cannot approve, post payments, authorize recovery, or transfer ownership.

- [ ] **Step 6: Implement staff credentials, MFA hook, and sessions**

Hash passwords with Argon2id using parameters recorded in configuration. Store only a hashed session token, rotate it on privilege changes, use Secure HttpOnly SameSite cookies, apply CSRF protection to cookie-authenticated mutations, and model MFA verification as a required session attribute. The real MFA channel is selected in the hosting and identity follow-on plan; production mode refuses staff sessions without verified MFA.

- [ ] **Step 7: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/api test
pnpm lint
pnpm typecheck
git add platform/apps/api platform/packages/db
git commit -m "feat: add secure API and staff access controls"
~~~

### Task 5: Define integration ports, simulators, and the durable worker

**Files:**
- Create: platform/packages/integrations/package.json
- Create: platform/packages/integrations/src/nia.ts
- Create: platform/packages/integrations/src/sms.ts
- Create: platform/packages/integrations/src/payments.ts
- Create: platform/packages/integrations/src/tracker.ts
- Create: platform/packages/integrations/src/credit-bureau.ts
- Create: platform/packages/integrations/src/erp.ts
- Create: platform/packages/integrations/src/simulators/
- Create: platform/packages/integrations/src/integrations.test.ts
- Create: platform/apps/worker/package.json
- Create: platform/apps/worker/src/main.ts
- Create: platform/apps/worker/src/jobs/dispatch-outbox.ts
- Create: platform/apps/worker/src/jobs/send-notification.ts
- Create: platform/apps/worker/src/jobs/recompute-arrears.ts
- Create: platform/apps/worker/test/worker.integration.test.ts

**Interfaces:**
- Consumes: OutboxMessage and database claim/update functions.
- Produces: NiaPort, SmsPort, PaymentWebhookVerifier, TrackerPort, CreditBureauPort, ErpPort, deterministic simulator adapters, and startWorker.

Use these exact provider boundaries:

~~~typescript
export interface NiaPort {
  verify(input: {
    correlationId: string;
    ghanaCardNumber: string;
    consentId: string;
  }): Promise<{
    providerReference: string;
    decision: "MATCH" | "NO_MATCH" | "REVIEW";
    checkedAt: string;
  }>;
}

export interface SmsPort {
  send(input: {
    idempotencyKey: string;
    phoneE164: string;
    template: string;
    variables: Readonly<Record<string, string>>;
  }): Promise<{ providerReference: string; acceptedAt: string }>;
}

export interface ErpPort {
  publish(event: {
    eventId: string;
    eventType: string;
    aggregateId: string;
    occurredAt: string;
    payload: unknown;
  }): Promise<{ externalReference: string }>;
}
~~~

- [ ] **Step 1: Write contract tests for all simulator adapters**

Verify idempotent SMS send, deterministic NIA results, read-only tracker behavior, manual credit-bureau mode, payment signature rejection, and ERP temporary failure.

- [ ] **Step 2: Run and verify failure**

Run:

~~~powershell
pnpm --filter @somo/integrations test
~~~

Expected: FAIL because adapters are absent.

- [ ] **Step 3: Implement ports and deterministic simulators**

Simulator behavior must be controlled by test fixtures, never random. Production configuration must reject simulator adapters.

- [ ] **Step 4: Write failing worker retry tests**

Test successful dispatch, exponential retry, maximum-attempt exception state, and two concurrent workers claiming distinct rows.

- [ ] **Step 5: Implement the worker loop**

Use database claims, heartbeat, bounded concurrency, idempotent handlers, structured logging, and graceful shutdown. Persist attempt timestamps and sanitized failure codes.

- [ ] **Step 6: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/integrations test
pnpm --filter @somo/worker test
pnpm typecheck
git add platform/packages/integrations platform/apps/worker
git commit -m "feat: add integration ports and durable worker"
~~~

### Task 6: Implement documents, SMS OTP, consent, and NIA orchestration

**Files:**
- Create: platform/apps/api/src/modules/documents/service.ts
- Create: platform/apps/api/src/modules/documents/routes.ts
- Create: platform/apps/api/src/modules/documents/policy.ts
- Create: platform/apps/api/src/modules/identity/otp-service.ts
- Create: platform/apps/api/src/modules/identity/nia-service.ts
- Create: platform/apps/api/src/modules/identity/routes.ts
- Create: platform/apps/api/src/modules/identity/consent-service.ts
- Create: platform/apps/api/test/identity.e2e.test.ts
- Create: platform/packages/integrations/src/object-storage.ts
- Create: platform/packages/integrations/src/malware-scanner.ts

**Interfaces:**
- Consumes: NiaPort, SmsPort, object-storage port, malware-scanner port, audit repository.
- Produces: OtpService.request, OtpService.verify, IdentityService.verifyGhanaCard, DocumentService.requestUpload, DocumentService.completeUpload, and ConsentService.record.

Define:

~~~typescript
export interface UploadTicket {
  documentId: string;
  uploadUrl: string;
  expiresAt: string;
  requiredHeaders: Readonly<Record<string, string>>;
}

export interface ConsentEvidence {
  consentId: string;
  subjectPersonId: string;
  documentVersion: string;
  acceptedAt: string;
  phoneE164: string;
  sessionId: string;
  ipAddress: string;
  userAgent: string;
}
~~~

- [ ] **Step 1: Write failing OTP abuse tests**

Test expiration, one-time use, attempt limit, resend cooldown, hashed code storage, generic response for unknown phone, and no plaintext OTP in logs.

- [ ] **Step 2: Implement OTP request and verification**

Generate codes with a cryptographic random source. Store a keyed hash, not the code. Send through SmsPort and invalidate all outstanding codes after successful verification.

- [ ] **Step 3: Write failing upload security tests**

Test disallowed MIME type, excessive size, mismatched magic bytes, malware result, expired upload ticket, and cross-user document access.

- [ ] **Step 4: Implement two-phase document upload**

Create metadata first, issue a short-lived upload ticket, scan on completion, calculate a cryptographic hash, and expose downloads only through audited expiring URLs. A document is not usable until scan status is CLEAN.

- [ ] **Step 5: Write failing NIA and consent tests**

Assert that a saved draft survives NIA outage, NO_MATCH cannot produce verified state, successful verification stores only the minimum result, and consent is immutable and versioned.

- [ ] **Step 6: Implement NIA and consent services**

Never store unnecessary biometric payloads. Audit subject, purpose, provider reference, decision, and time.

- [ ] **Step 7: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/api test -- test/identity.e2e.test.ts
pnpm --filter @somo/api test
pnpm typecheck
git add platform/apps/api/src/modules/documents platform/apps/api/src/modules/identity platform/packages/integrations
git commit -m "feat: add secure identity and document evidence"
~~~

### Task 7: Build applicant and independent guarantor onboarding

**Files:**
- Create: platform/apps/api/src/modules/applications/service.ts
- Create: platform/apps/api/src/modules/applications/routes.ts
- Create: platform/apps/api/src/modules/applications/completeness.ts
- Create: platform/apps/api/test/applications.e2e.test.ts
- Create: platform/apps/customer-web/package.json
- Create: platform/apps/customer-web/src/app/router.tsx
- Create: platform/apps/customer-web/src/features/auth/
- Create: platform/apps/customer-web/src/features/application/
- Create: platform/apps/customer-web/src/features/guarantor/
- Create: platform/apps/customer-web/src/features/documents/
- Create: platform/apps/customer-web/src/lib/api.ts
- Create: platform/apps/customer-web/public/manifest.webmanifest
- Create: platform/apps/customer-web/src/service-worker.ts
- Create: platform/apps/customer-web/src/application.test.tsx

**Interfaces:**
- Consumes: identity, consent, document, product-catalogue read API, and application transition rules.
- Produces: ApplicationService.createDraft, saveApplicant, inviteGuarantor, saveGuarantor, getCompleteness, submit, and customer PWA routes.

- [ ] **Step 1: Write failing application-service tests**

Cover draft creation, auto-save version conflicts, applicant-only access, guarantor invitation expiry, guarantor isolation, mandatory NIA checks, mandatory clean documents, and submission completeness.

~~~typescript
it("does not submit until the guarantor completes independently", async () => {
  const draft = await service.createDraft(applicantContext());
  await completeApplicant(service, draft.id);
  await expect(service.submit(draft.id, applicantContext()))
    .rejects.toMatchObject({ code: "GUARANTOR_INCOMPLETE" });
});
~~~

- [ ] **Step 2: Run and verify failure**

Run:

~~~powershell
pnpm --filter @somo/api test -- test/applications.e2e.test.ts
~~~

Expected: FAIL because ApplicationService is absent.

- [ ] **Step 3: Implement application commands and completeness rules**

Persist applicant and guarantor sections separately. Use optimistic version checks for auto-save. Submission creates an immutable application_version snapshot and moves to VERIFICATION_REVIEW in one transaction with audit and outbox records.

- [ ] **Step 4: Write failing customer PWA tests**

Test phone login, resume, model selection, applicant steps, document progress, guarantor invitation status, accessible error summary, and offline draft retry. The service worker may cache versioned static assets only; test that it never caches identity documents, API responses, receipts, or contract files.

- [ ] **Step 5: Implement the mobile-first PWA**

Use semantic form controls, explicit save state, upload progress, low-bandwidth image preparation, session timeout warning, and a status timeline. Build only the approved flow; do not expose staff modes.

- [ ] **Step 6: Add end-to-end browser scenario**

Playwright must complete applicant onboarding, open a separate guarantor browser context, complete guarantor onboarding, and submit the application.

- [ ] **Step 7: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/customer-web test
pnpm --filter @somo/api test -- test/applications.e2e.test.ts
pnpm --filter @somo/customer-web e2e
git add platform/apps/customer-web platform/apps/api/src/modules/applications platform/apps/api/test/applications.e2e.test.ts
git commit -m "feat: add applicant and guarantor onboarding"
~~~

### Task 8: Implement the fixed approval workflow and staff queues

**Files:**
- Create: platform/apps/api/src/modules/approvals/service.ts
- Create: platform/apps/api/src/modules/approvals/underwriting-service.ts
- Create: platform/apps/api/src/modules/approvals/routes.ts
- Create: platform/apps/api/src/modules/approvals/policy.ts
- Create: platform/apps/api/test/approvals.e2e.test.ts
- Create: platform/apps/staff-web/package.json
- Create: platform/apps/staff-web/src/app/router.tsx
- Create: platform/apps/staff-web/src/features/auth/
- Create: platform/apps/staff-web/src/features/queues/
- Create: platform/apps/staff-web/src/features/application-review/
- Create: platform/apps/staff-web/src/features/access/
- Create: platform/apps/staff-web/src/approvals.test.tsx

**Interfaces:**
- Consumes: authorize, application repository, transition rules, audit/outbox.
- Produces: ApprovalService.getQueue, requestInformation, resubmit, approve, reject; UnderwritingService.recordManualCreditBureauCheck; and role-scoped staff UI.

- [ ] **Step 1: Write failing workflow tests**

Test every stage transition, wrong-role denial, stage skipping, duplicate decision, returned-information versioning, rejection terminal behavior, audit evidence, and manual credit-bureau evidence recording.

- [ ] **Step 2: Implement stage-specific commands**

ApprovalService.approve accepts applicationId, expectedVersion, stage, actor, and note. It determines the next status server-side; clients cannot supply a target status.

- [ ] **Step 3: Write failing separation-of-duty tests**

Test that a user cannot approve an exception they requested, a technical administrator cannot decide, and temporary delegation expires.

- [ ] **Step 4: Implement staff queues and detail pages**

Each role sees only actionable records and read-only history. Display application snapshots, NIA references, document scan state, statements, prior decisions, and exact status.

Verification staff can record a manual credit-bureau check with bureau reference, result, check date, officer, and clean evidence document. The result informs underwriting but cannot independently approve or reject.

- [ ] **Step 5: Add full-chain Playwright test**

Use separate authenticated browser contexts for Verification Officer, BSM, AGM, CFO, BSM final, and MD. Assert the application appears in exactly one actionable queue after each decision.

- [ ] **Step 6: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/api test -- test/approvals.e2e.test.ts
pnpm --filter @somo/staff-web test
pnpm --filter @somo/staff-web e2e
git add platform/apps/api/src/modules/approvals platform/apps/staff-web
git commit -m "feat: enforce approval chain and role queues"
~~~

### Task 9: Implement versioned products, exceptions, offers, and schedules

**Files:**
- Create: platform/packages/domain/src/financing/types.ts
- Create: platform/packages/domain/src/financing/flat-markup.ts
- Create: platform/packages/domain/src/financing/reducing-balance.ts
- Create: platform/packages/domain/src/financing/schedule.ts
- Create: platform/packages/domain/src/financing/financing.test.ts
- Create: platform/apps/api/src/modules/products/service.ts
- Create: platform/apps/api/src/modules/products/routes.ts
- Create: platform/apps/api/src/modules/products/exception-service.ts
- Create: platform/apps/api/src/modules/products/offer-service.ts
- Create: platform/apps/api/test/products.e2e.test.ts
- Create: platform/apps/staff-web/src/features/products/
- Create: platform/apps/customer-web/src/features/offer/

**Interfaces:**
- Consumes: Money, application approval state, product tables, authorization.
- Produces: FinancingEngine.quote, ProductService.publishRuleVersion, ExceptionService.request and decide, OfferService.create and accept.

Define:

~~~typescript
export interface QuoteInput {
  priceMinor: bigint;
  depositMinor: bigint;
  pricing:
    | {
        method: "FLAT_MARKUP";
        markupBasisPoints: number;
      }
    | {
        method: "REDUCING_BALANCE";
        annualRateBasisPoints: number;
      };
  frequency: "WEEKLY" | "MONTHLY";
  tenureMonths: 6 | 8 | 12 | 24 | 36 | 48;
  firstDueDate: string;
}

export interface QuoteResult {
  principalMinor: bigint;
  financeChargeMinor: bigint;
  totalPayableMinor: bigint;
  installments: readonly {
    sequence: number;
    dueDate: string;
    principalMinor: bigint;
    chargeMinor: bigint;
    totalMinor: bigint;
  }[];
}
~~~

- [ ] **Step 1: Encode algorithm invariants as failing tests**

Test deposit cannot exceed price, dates are calendar-correct, sum of installment totals equals total payable, all non-final installments follow the rounding rule, and final installment absorbs the residual.

- [ ] **Step 2: Implement deterministic date and rounding helpers**

Use calendar-date arithmetic and decimal.js with explicit rounding. Do not use JavaScript Date millisecond increments for contractual months.

- [ ] **Step 3: Add Finance-approved fixture gate**

Create a JSON schema for signed worked examples. Transcribe Finance-approved examples verbatim when supplied; do not choose commercial rates or disclosure behavior. Production configuration refuses to enable a method, frequency, or tenure with no approved fixture hash.

- [ ] **Step 4: Implement calculation strategies against the fixtures**

Keep flat and reducing strategies separate behind FinancingEngine.quote. Add regression tests for every approved example.

- [ ] **Step 5: Write failing product-version and exception tests**

Test effective dating, immutable published versions, disabled unlicensed tenure, minimum-deposit enforcement, requester cannot approve, accepted offer remains unchanged after a new rule version, and offer expiry.

- [ ] **Step 6: Implement product, exception, and offer services**

Offer acceptance records exact rule version, calculation inputs, schedule, disclosures version, applicant consent, and cryptographic hash.

- [ ] **Step 7: Build staff configuration and customer offer screens**

Staff screens require maker-checker publishing. Customer screen displays price, deposit, frequency, tenure, installment count, installment amount, total cost, fees, and accepted disclosures.

- [ ] **Step 8: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/domain test -- src/financing/financing.test.ts
pnpm --filter @somo/api test -- test/products.e2e.test.ts
pnpm --filter @somo/customer-web test
pnpm --filter @somo/staff-web test
git add platform/packages/domain/src/financing platform/apps/api/src/modules/products platform/apps/customer-web/src/features/offer platform/apps/staff-web/src/features/products
git commit -m "feat: add controlled financing offers"
~~~

### Task 10: Implement vehicle assignment, contract execution, and handover

**Files:**
- Create: platform/apps/api/src/modules/assets/service.ts
- Create: platform/apps/api/src/modules/assets/routes.ts
- Create: platform/apps/api/src/modules/contracts/service.ts
- Create: platform/apps/api/src/modules/contracts/routes.ts
- Create: platform/apps/api/src/modules/contracts/template.ts
- Create: platform/apps/api/test/assets-contracts.e2e.test.ts
- Create: platform/apps/staff-web/src/features/assets/
- Create: platform/apps/staff-web/src/features/contracts/
- Create: platform/apps/customer-web/src/features/contract/

**Interfaces:**
- Consumes: accepted offer, reconciled deposit signal, DocumentService, authorization.
- Produces: AssetService.assignVehicle, ContractService.generate, recordPhysicalExecution, activate, HandoverService.complete.

- [ ] **Step 1: Write failing asset-state tests**

Test duplicate VIN, assignment before deposit, reassignment without approval, missing or expired registration or insurance, renewal-date alerts, and tracker association access.

- [ ] **Step 2: Implement vehicle-unit and assignment commands**

Record model, VIN or chassis, engine or motor identifier, registration, insurance, tracker ID, condition, status, and optimistic version.

- [ ] **Step 3: Write failing contract-gate tests**

Test generation uses locked offer, physical execution requires applicant and guarantor signatures, uploaded executed PDF hash is immutable, handover requires checklist, and activation requires all gates.

- [ ] **Step 4: Implement contract and handover services**

ContractService.generate uses an approved template version and locked data. Production mode rejects an unsigned or unapproved legal template version. Physical execution stores signatories, staff witness, date, clean document ID, and hash.

- [ ] **Step 5: Build staff and customer screens**

Staff can manage inventory, assignment, execution, and handover. Customer can view the locked offer, unsigned contract preview, executed contract, assigned vehicle after handover, registration/insurance summary, and schedule.

- [ ] **Step 6: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/api test -- test/assets-contracts.e2e.test.ts
pnpm --filter @somo/staff-web test
pnpm --filter @somo/customer-web test
git add platform/apps/api/src/modules/assets platform/apps/api/src/modules/contracts platform/apps/staff-web/src/features/assets platform/apps/staff-web/src/features/contracts platform/apps/customer-web/src/features/contract
git commit -m "feat: add asset contract and handover controls"
~~~

### Task 11: Implement payment inbox, immutable ledger, receipts, and reconciliation

**Files:**
- Create: platform/apps/api/src/modules/payments/webhook-routes.ts
- Create: platform/apps/api/src/modules/payments/webhook-service.ts
- Create: platform/apps/api/src/modules/payments/ledger-service.ts
- Create: platform/apps/api/src/modules/payments/reconciliation-service.ts
- Create: platform/apps/api/src/modules/payments/receipt-service.ts
- Create: platform/apps/api/test/payments.integration.test.ts
- Create: platform/apps/worker/src/jobs/reconcile-payments.ts
- Create: platform/apps/staff-web/src/features/payments/
- Create: platform/apps/customer-web/src/features/payments/

**Interfaces:**
- Consumes: PaymentWebhookVerifier, inbox, contract schedule, Money, SmsPort, audit/outbox.
- Produces: POST /v1/integrations/payments/somoco, LedgerService.post, reverse, adjust, ReconciliationService.match and resolve, ReceiptService.issue.

Canonical event:

~~~typescript
export interface CanonicalPaymentEvent {
  eventId: string;
  eventType: "PAYMENT_SUCCEEDED" | "PAYMENT_REVERSED" | "PAYMENT_REFUNDED";
  providerTransactionId: string;
  payerPhoneE164: string;
  customerReference: string;
  amount: { currency: "GHS"; minorUnits: string };
  occurredAt: string;
  settlementReference?: string;
}
~~~

- [ ] **Step 1: Write failing webhook security and idempotency tests**

Test invalid signature, stale timestamp, malformed body, unknown event, duplicate event ID, duplicate transaction ID, and replay after successful response.

- [ ] **Step 2: Implement durable webhook receipt**

Verify the raw bytes before JSON parsing when the provider contract requires it. In one transaction, store the inbox event and return a stable acknowledgement. Duplicate delivery returns the original acknowledgement.

- [ ] **Step 3: Write failing ledger tests**

Test exact posting, deposit gate signal, partial payment, excess payment reconciliation, reversal, adjustment maker-checker, no update/delete API, and allocation policy version.

- [ ] **Step 4: Implement immutable ledger and reconciliation**

All corrections create linked entries. Unmatched events stay in reconciliation and never create a guessed customer allocation.

- [ ] **Step 5: Implement receipt and settlement jobs**

Issue one receipt per posted payment, send SMS idempotently, and compare provider settlement totals to ledger totals. Variances create reconciliation cases and alerts.

- [ ] **Step 6: Build customer and finance screens**

Customer sees USSD instructions, balance, due dates, posted payments, and receipts. Finance sees inbox events, unmatched payments, settlement batches, reversals, adjustments, and maker-checker actions.

- [ ] **Step 7: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/api test -- test/payments.integration.test.ts
pnpm --filter @somo/worker test
pnpm --filter @somo/customer-web test
pnpm --filter @somo/staff-web test
git add platform/apps/api/src/modules/payments platform/apps/worker/src/jobs/reconcile-payments.ts platform/apps/customer-web/src/features/payments platform/apps/staff-web/src/features/payments
git commit -m "feat: add payment ledger and reconciliation"
~~~

### Task 12: Implement arrears, notifications, recovery cases, and settlement

**Files:**
- Create: platform/packages/domain/src/arrears.ts
- Create: platform/packages/domain/src/arrears.test.ts
- Create: platform/apps/api/src/modules/collections/service.ts
- Create: platform/apps/api/src/modules/collections/routes.ts
- Create: platform/apps/api/src/modules/notifications/service.ts
- Create: platform/apps/api/src/modules/contracts/settlement-service.ts
- Create: platform/apps/api/test/collections.e2e.test.ts
- Create: platform/apps/worker/src/jobs/recompute-arrears.ts
- Create: platform/apps/worker/src/jobs/send-reminders.ts
- Create: platform/apps/staff-web/src/features/collections/
- Create: platform/apps/customer-web/src/features/account-status/

**Interfaces:**
- Consumes: schedule, ledger balance, SmsPort, TrackerPort, authorization, audit/outbox.
- Produces: computeArrears, CollectionsService.openCase, decideEscalation, recordAction, SettlementService.reconcile and transferOwnership.

- [ ] **Step 1: Write failing arrears tests**

Test on-time account, one missed installment, three consecutive missed, three total but nonconsecutive unpaid, partial payment, reversal reopening arrears, and future installment exclusion.

- [ ] **Step 2: Implement pure arrears calculation**

Return:

~~~typescript
export interface ArrearsResult {
  asOfDate: string;
  overdueMinor: bigint;
  consecutiveMissed: number;
  totalUnpaid: number;
  escalationSignals: readonly (
    | "THREE_CONSECUTIVE_MISSED"
    | "THREE_TOTAL_UNPAID"
  )[];
}
~~~

- [ ] **Step 3: Write failing recovery-control tests**

Test that signals do not open a case automatically, recovery officer cannot authorize own action, location lookup requires an active case and purpose, and no immobilization command exists.

- [ ] **Step 4: Implement notifications and recovery cases**

Messages include a secure account link and current USSD instructions. Record reminder delivery and administrator decisions. Tracker adapter is read-only.

- [ ] **Step 5: Write failing settlement and ownership tests**

Require zero contractual balance, no unresolved reconciliation, finance approval, business approval, and uploaded transfer evidence.

- [ ] **Step 6: Implement settlement and ownership transfer**

Generate outbox events ContractSettled and OwnershipTransferred. Preserve Somoco ownership until the final transition commits.

- [ ] **Step 7: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/domain test -- src/arrears.test.ts
pnpm --filter @somo/api test -- test/collections.e2e.test.ts
pnpm --filter @somo/worker test
pnpm --filter @somo/staff-web test
git add platform/packages/domain/src/arrears.ts platform/packages/domain/src/arrears.test.ts platform/apps/api/src/modules/collections platform/apps/api/src/modules/notifications platform/apps/api/src/modules/contracts/settlement-service.ts platform/apps/worker/src/jobs platform/apps/staff-web/src/features/collections platform/apps/customer-web/src/features/account-status
git commit -m "feat: add arrears recovery and settlement controls"
~~~

### Task 13: Add reporting, audit review, and quarantined legacy import

**Files:**
- Create: platform/apps/api/src/modules/reports/service.ts
- Create: platform/apps/api/src/modules/reports/routes.ts
- Create: platform/apps/api/src/modules/migration/schema.ts
- Create: platform/apps/api/src/modules/migration/service.ts
- Create: platform/apps/api/src/modules/migration/routes.ts
- Create: platform/apps/api/test/reports-migration.e2e.test.ts
- Create: platform/apps/staff-web/src/features/reports/
- Create: platform/apps/staff-web/src/features/audit/
- Create: platform/apps/staff-web/src/features/migration/
- Create: platform/scripts/generate-legacy-template.mjs

**Interfaces:**
- Consumes: all read models, audit records, migration tables, object storage.
- Produces: portfolio and operations reports, attributable exports, MigrationService.validate, importBatch, verifyBatch, approveBatch.

- [ ] **Step 1: Write failing report authorization tests**

Test role filters, personal-data redaction, audit export attribution, watermark or requester attribution on downloadable reports, and denial of customer-document exports to unauthorized roles.

- [ ] **Step 2: Implement report queries and export audit**

Include stage age, turnaround, NIA exceptions, offers awaiting deposit, reconciliation, asset state, portfolio, consecutive missed, total unpaid, escalation flags, recovery, integration exceptions, and migration totals.

- [ ] **Step 3: Write failing migration tests**

Test schema errors, duplicate Ghana Card, duplicate contract reference, ambiguous match quarantine, idempotent rerun, amount reconciliation, two-person verification, and activation only after finance approval.

- [ ] **Step 4: Implement Excel/CSV validation and quarantined import**

Use a versioned template. Import essential structured data and one clean scanned legacy attachment reference. Preserve source row, source file hash, legacy IDs, and batch ID.

- [ ] **Step 5: Build migration and audit screens**

Show row-level errors, totals, sampling status, verifier, approver, and activation history. Never allow migration to overwrite an active live record.

- [ ] **Step 6: Verify and commit**

Run:

~~~powershell
pnpm --filter @somo/api test -- test/reports-migration.e2e.test.ts
pnpm --filter @somo/staff-web test
pnpm typecheck
git add platform/apps/api/src/modules/reports platform/apps/api/src/modules/migration platform/apps/staff-web/src/features/reports platform/apps/staff-web/src/features/audit platform/apps/staff-web/src/features/migration platform/scripts/generate-legacy-template.mjs
git commit -m "feat: add reporting audit and migration quarantine"
~~~

### Task 14: Add observability, security verification, and deployable configuration

**Files:**
- Modify: platform/package.json
- Modify: platform/apps/api/src/app.ts
- Modify: platform/apps/api/src/config.ts
- Modify: platform/apps/worker/src/main.ts
- Create: platform/packages/integrations/src/telemetry.ts
- Create: platform/apps/api/src/modules/privacy/service.ts
- Create: platform/apps/api/src/modules/privacy/routes.ts
- Create: platform/apps/api/test/privacy.e2e.test.ts
- Create: platform/apps/customer-web/src/features/privacy/
- Create: platform/apps/staff-web/src/features/privacy/
- Create: platform/infra/compose.dev.yml
- Create: platform/infra/reverse-proxy/security-headers.conf
- Create: platform/scripts/verify-pilot-gates.mjs
- Create: platform/docs/operations/backup-restore.md
- Create: platform/docs/operations/incident-response.md
- Create: platform/docs/operations/provider-failure.md
- Create: platform/docs/security/threat-model.md
- Create: platform/test/security/config.test.ts

**Interfaces:**
- Consumes: all applications and configuration.
- Produces: PrivacyService.openRequest, exportSubjectData, recordCorrection, restrictProcessing, applyRetention; health endpoints; OpenTelemetry traces/metrics; redacted logs; pilot-gate verifier; restore and incident runbooks.

- [ ] **Step 1: Write failing production-config tests**

Assert production refuses simulator adapters, weak secrets, HTTP origins, missing MFA enforcement, public object-storage configuration, missing encryption-key reference, and absent backup verification date.

- [ ] **Step 2: Implement strict environment validation**

Do not provide insecure production defaults. Keep .env.example synthetic and secret-free.

- [ ] **Step 3: Write failing privacy-lifecycle tests**

Test subject-access export, correction by append-only amendment, processing restriction, legal hold, retention-policy versioning, and deletion or anonymization only where the approved policy permits it.

- [ ] **Step 4: Implement privacy request and retention services**

Applicants and guarantors can submit access and correction requests. Compliance staff can review, export, amend, restrict, and close them. A retention job refuses to act without an approved policy version and never removes immutable financial, approval, or audit evidence that must legally remain.

- [ ] **Step 5: Write failing observability tests**

Test request correlation propagation to outbox jobs, secret and OTP redaction, dependency health, queue age, payment reconciliation variance, and provider failure counters.

- [ ] **Step 6: Add telemetry and health**

Separate liveness from readiness. Readiness fails for required dependencies but does not expose internal details publicly.

- [ ] **Step 7: Create local infrastructure and operations runbooks**

The development compose file may include PostgreSQL, S3-compatible storage, and ClamAV. Docker is not installed on the current workstation, so execution must either install an approved container runtime or use Somoco-provided development services. Do not skip integration tests because Docker is absent.

- [ ] **Step 8: Implement the pilot-gate verifier**

The script reads signed gate records from production configuration and fails if licence, legal, privacy, NIA, SMS, payment, hosting, finance calculation, restore, or security gates are missing or expired.

Add this root script:

~~~json
"verify:pilot-gates": "node scripts/verify-pilot-gates.mjs"
~~~

- [ ] **Step 9: Run security and workspace verification**

Run:

~~~powershell
pnpm audit --prod
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify:pilot-gates -- --environment test
~~~

Expected: all commands exit 0; test mode uses signed synthetic gate fixtures only.

- [ ] **Step 10: Commit**

~~~powershell
git add platform/apps platform/packages/integrations platform/infra platform/scripts platform/docs platform/test
git commit -m "chore: add production security and operations controls"
~~~

### Task 15: Prove the complete controlled-pilot flow

**Files:**
- Modify: platform/package.json
- Create: platform/test/e2e/pilot-happy-path.spec.ts
- Create: platform/test/e2e/information-request.spec.ts
- Create: platform/test/e2e/payment-replay.spec.ts
- Create: platform/test/e2e/recovery-control.spec.ts
- Create: platform/test/e2e/ownership-transfer.spec.ts
- Create: platform/test/load/application-flow.ts
- Create: platform/docs/pilot/uat-script.md
- Create: platform/docs/pilot/go-no-go-checklist.md
- Create: platform/docs/pilot/rollback.md

**Interfaces:**
- Consumes: the complete simulator-backed platform.
- Produces: executable pilot acceptance evidence and operational UAT scripts.

- [ ] **Step 1: Write the end-to-end happy-path test**

Add these root scripts:

~~~json
"e2e": "playwright test",
"test:load": "tsx test/load/application-flow.ts"
~~~

The test must:

1. Create applicant session by SMS OTP.
2. Complete applicant NIA and clean documents.
3. Invite and separately authenticate guarantor.
4. Complete guarantor NIA, documents, consent, and signature.
5. Submit.
6. Pass each approval role in order.
7. Create and accept an approved financing offer.
8. Receive a signed deposit event once despite replay.
9. Assign a VIN.
10. Record physical contract execution and handover.
11. Receive repayments and issue receipts.
12. Settle and transfer ownership with two approvals.

- [ ] **Step 2: Run the test and verify any missing behavior fails**

Run:

~~~powershell
pnpm exec playwright test test/e2e/pilot-happy-path.spec.ts
~~~

Expected before final wiring: FAIL at the first unconnected route or UI action.

- [ ] **Step 3: Wire only the missing application boundaries**

Do not bypass public APIs by writing directly to tables. Keep provider activity through simulator ports and staff activity through authenticated UI/API actions.

- [ ] **Step 4: Add adverse-flow tests**

Cover information request/resubmission, NIA outage, OTP abuse, document malware, wrong-role approval, unlicensed tenure, payment replay, unmatched payment, SAP outage, three-payment signals, unauthorized tracker access, attempted automatic recovery, and ownership transfer with outstanding balance.

- [ ] **Step 5: Run load and resilience tests**

Exercise above 5,000 applications per month, expected staff queues, concurrent webhooks, worker restart, provider outage, and database restore. Record measured p95 latency, queue age, and reconciliation results.

- [ ] **Step 6: Execute full verification**

Run:

~~~powershell
pnpm verify
pnpm exec playwright test
pnpm test:load
pnpm verify:pilot-gates -- --environment test
git status --short
~~~

Expected: every command exits 0, no unexplained generated files, no critical security result, and no ledger variance.

- [ ] **Step 7: Complete role-based UAT rehearsal**

Use synthetic identities and payments. Each Somoco role follows platform/docs/pilot/uat-script.md and signs the result. Record defects; critical or financial-integrity defects block pilot.

- [ ] **Step 8: Commit**

~~~powershell
git add platform/test platform/docs/pilot
git commit -m "test: prove controlled pilot workflows"
~~~

## Follow-on plan gates

Do not declare the real pilot ready after completing this core plan. Create and execute provider-specific plans from the actual documentation for NIA, SMS, and Somoco payments. Create the approved-hosting plan from Somoco's infrastructure specification. Run the same adapter contract, end-to-end, security, reconciliation, restore, and go/no-go checks against those real environments.

SAP synchronization remains off until SAP discovery establishes the product/version, approved interface or middleware, source-of-truth matrix, accounting mappings, and test environment. Core outbox events must be retained so the SAP plan does not require domain rewrites.
