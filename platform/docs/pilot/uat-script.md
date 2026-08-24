# Controlled-pilot UAT script

Status: `PENDING — synthetic rehearsal template; no role has pre-signed this document`
Environment: disposable simulator only
Run ID: ____________________ Date/time (UTC): ____________________ Facilitator: ____________________

This rehearsal proves the simulator-backed core and launch controls. It does not substitute for provider sandbox evidence, hosting rehearsal, legal approval, DPC/DPIA approval, restore evidence, penetration testing, or signed business UAT. Use synthetic Ghana Card values, phones, documents, and payments only. Never paste a real person's data into this run.

## Automated evidence boundary

The real-app API composition is exercised by `apps/api/test/task15-controlled-pilot.e2e.test.ts` and the four adverse HTTP specs against the disposable PostgreSQL service `postgresql://somo_test@127.0.0.1:55432/somo_bnpl_test`. It uses production `buildApp`, repeat-safe migrations, OTP/customer sessions, signed staff cookies, simulator ports, worker dispatch code, and public HTTP routes. The current automated run proves applicant product selection, independent applicant/guarantor consent/NIA/document evidence and signatures, six-stage approval attribution, offer acceptance, simulator payment deposit reconciliation and replay-safe contract binding, declared `INVENTORY_OFFICER` VIN/registration/insurance assignment, physical execution and handover, activation, distinct arrears signals, repayment ledger/receipt replay, clean settlement with dual approvals, and ownership transfer. Durable assertions read back privacy signature evidence, audit actor/stage/idempotency history, payment/receipt/ledger rows, contract state, settlement approvals, and transfer state.

The disposable run also proves NIA outage recovery, OTP abuse rejection, malware rejection, wrong-role/licence guards, unmatched payment quarantine, payment simulator outage/recovery, unauthorized tracker access, explicit automatic recovery/immobilization denial, outstanding-balance transfer denial, and a real outbox claim/restart/reclaim (`ABANDONED` then `PUBLISHED`) with queue age measured independently from request latency. The following remain `PENDING` and must not be marked Pass from simulator output: real provider contract/sandbox evidence, production hosting/TLS/capacity, backup/restore integrity, penetration/security sign-off, legal/privacy approval, and signed business UAT. These are release gates, not test-fixture substitutions.

## Entry checks

Record the exact commit and commands before starting:

- Commit: ____________________
- `node node_modules/@playwright/test/cli.js test --config playwright.config.ts`: ____________________
- `node node_modules/tsx/dist/cli.mjs test/load/application-flow.ts`: ____________________
- Pilot-gate verifier result: ____________________
- Disposable database/service identifiers: ____________________
- Evidence folder and hash manifest: ____________________

Stop and mark the run blocked if an external dependency is substituted without an approved adapter, if a financial-integrity assertion fails, or if a real person's data is encountered.

## Role-by-role rehearsal

For every row, attach request/response evidence with secrets and personal data redacted. “Pass” means the expected boundary and invariant were observed; it is not a production sign-off.

| Role                 | Synthetic actions                                                                                                                                                                                                                     | Expected evidence / invariant                                                                                                                                                                 | Result                  | Defect severity / ID | Sign-off (name, date, signature) |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | -------------------- | -------------------------------- |
| Applicant            | Request SMS OTP; authenticate; record NIA consent; complete NIA; upload a clean Ghana Card document; choose model; invite guarantor; submit; review offer; accept; acknowledge handover; inspect payment receipts and account status. | Applicant and guarantor sessions are different; no submission before both identities/documents; cash is not offered; Somoco remains owner until final transfer.                               | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| Guarantor            | Authenticate independently; resolve invitation; record consent; complete NIA and clean document; provide profile, consent, and signature.                                                                                             | Invitation bearer is never returned by the API; guarantor cannot edit applicant-only fields; guarantor completion is attributable to the guarantor session.                                   | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| Verification Officer | Open verification queue; approve the first stage; request information once; verify that applicant resubmission returns to the same stage; approve after resubmission.                                                                 | Exact six-stage order is enforced; wrong role is denied; information request pauses progression and resubmission is idempotent/audited.                                                       | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| BSM — initial        | Review and approve `BSM_INITIAL`.                                                                                                                                                                                                     | The initial BSM approval is distinct from final BSM approval and is recorded with stage, actor, note, version, and idempotency key.                                                           | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| AGM                  | Review and approve `AGM`.                                                                                                                                                                                                             | AGM cannot approve another stage; stale versions and replays do not create extra approvals.                                                                                                   | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| CFO                  | Review and approve `CFO`; compare settlement totals; approve clean financial settlement only.                                                                                                                                         | Finance approval requires zero contractual balance and no unresolved reconciliation; amount values remain GHS integer minor-unit strings.                                                     | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| BSM — final          | Review and approve `BSM_FINAL`.                                                                                                                                                                                                       | Final BSM approval is separately attributable and precedes MD; the queue cannot be skipped.                                                                                                   | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| MD                   | Review and approve `MD`; provide business settlement approval; commit settlement; transfer ownership.                                                                                                                                 | MD is the final approval; settlement requires finance approval, business approval, clean evidence, zero balance, and no reconciliation cases; ownership changes only at the final transition. | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| Finance              | Inspect inbox, receipts, ledger, replay, unmatched payment, and reconciliation queue; resolve only with authorized evidence.                                                                                                          | Replayed webhook has one ledger entry and one receipt; unmatched payment is never guessed to a customer; no update/delete correction path exists.                                             | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| Collections          | Review arrears; distinguish three consecutive missed installments from three total unpaid installments; open and approve a human recovery case; request location only for an approved case.                                           | No case opens automatically; tracker returns location only; no immobilization or automatic recovery command exists.                                                                           | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| Compliance           | Review consent, identity/document evidence, audit export, privacy restrictions, retention hold, and defect log.                                                                                                                       | Consent versions and subject actions are attributable; exports are redacted/watermarked; immutable financial, approval, and audit evidence is retained.                                       | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |
| Operations           | Register vehicle; verify registration/insurance/evidence; assign VIN only after approved offer and reconciled deposit; generate, execute, hand over, and activate contract.                                                           | VIN/chassis is not assigned early; applicant and guarantor signatures plus staff witness are present; handover checklist and acknowledgement are recorded.                                    | ☐ Pass ☐ Fail ☐ Blocked | ____________________ | ____________________             |

## Adverse checks

Record the response code, sanitized problem code, and evidence hash for each:

1. NIA outage is a bounded unavailable response and does not mark identity verified; recovery succeeds through the simulator control.
2. OTP request/verification abuse is rate-limited and locked without revealing secrets.
3. Malware document is quarantined and cannot satisfy completeness.
4. Wrong-role approval and licence-disallowed tenure are denied.
5. Replayed, unmatched, and simulator-outage payments preserve transaction, ledger, receipt, and reconciliation invariants; cash is rejected.
6. SAP synchronization remains disabled pending discovery; no production endpoint is called.
7. Three-consecutive and three-total unpaid signals remain separate.
8. Unauthorized tracker access, automatic recovery, and automatic immobilization are denied.
9. Ownership transfer with an outstanding balance or unclean reconciliation is denied.
10. Applicant and guarantor signature actions are independently authenticated, offer-bound, durable, and replay-safe.

Adverse evidence references: ____________________________________________________________

## Defect and sign-off rules

- Critical: financial-integrity loss, unauthorized access/action, wrong ownership, skipped approval, duplicate ledger/receipt, data disclosure, or evidence deletion. **Immediate UAT failure and pilot block.**
- High: a required workflow cannot complete, fail-closed boundary is bypassable, or recovery/rollback control is untestable. **Pilot block until retest passes.**
- Medium/Low: usability, copy, or non-blocking operational defect. Accept only with named owner, due date, and risk acceptance.

Overall UAT result: ☐ PASS ☐ FAIL ☐ BLOCKED Defect log: ____________________ Retest date: ____________________
Business owner: ____________________ Compliance: ____________________ Finance: ____________________ Operations: ____________________
Final decision is intentionally blank until the named Somoco approvers sign with evidence attached.
