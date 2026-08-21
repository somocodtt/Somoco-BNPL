# Task 11 report — payment ledger and reconciliation

Base: `66c27d2445938201a46b544244c33c17d43487ea`

## TDD evidence

- RED accepted: the first focused payment run failed because the payment webhook service boundary did not exist. The test dependency resolution was corrected without changing the test contract.
- GREEN: the focused payment/API suite passes 14/14 on disposable PostgreSQL. It covers raw-byte capture, verifier failures, duplicate event/provider transaction handling, stable acknowledgements, rollback, exact allocation, quarantine, deposit reconciliation, reversal compensation, maker/checker controls, settlement matching/variance, malformed HTTP JSON, and the absence of a cash endpoint.
- Worker reconciliation job passes 3/3 focused tests and 33/33 for the complete worker suite.
- Customer payment UI passes 3/3; finance payment UI passes 3/3.
- Integration boundary suite passes 22/22, including production connector wrapping for the Somoco payment verifier and rejection of simulator adapters.

## Database and migration evidence

- Database suite passes 31/31 on `postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`.
- Fresh migration journal applies 17 migrations; repeat migration calls leave the count at 17.
- A populated legacy payment/ledger graph survives 0001 through 0016 with payment and ledger amounts unchanged; new receipt/settlement tables are empty and append-only triggers are present.
- Receipt and settlement mutation triggers are installed; ledger/audit append-only controls remain covered by the existing database tests.
- Drizzle generation passes with no schema changes after the 0016 snapshot was added. The existing BigInt schema default was changed to a SQL literal so generation is deterministic.

## Verification gates

- API, worker, customer-web, staff-web, database, and integrations TypeScript checks pass.
- Task 11 lint and Prettier checks pass.
- API, worker, database, integrations, customer-web, and staff-web production builds pass.
- `git diff --check` passes.

## Security and boundary review

- Production app composition requires a registered production payment verifier and SMS connector; absent or unregistered production dependencies fail closed.
- Payment webhook verification receives exact raw bytes and durable inbox acknowledgement is transactional.
- Financial corrections use linked compensation or adjustment ledger entries; payment receipts and settlement batches are database append-only.
- Customer and staff payment reads are session/role scoped. Adjustment mutations require a Finance Officer maker and separate CFO/Compliance checker; system administrators have no payment authority.
- Receipt SMS payloads contain only a validated HTTPS receipt link and current USSD instructions; provider payloads and secrets are not sent to SMS.
- No cash mutation route or vehicle immobilization command was added.

## External readiness note

The repository supplies the provider-neutral Somoco payment verifier and production connector boundary. Somoco must still provide and validate the real payment webhook/settlement contract, production connector provenance, SMS worker deployment configuration, and hosting secrets before accepting live customer payments. No invented provider algorithm or credential is included.
