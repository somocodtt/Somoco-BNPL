# Controlled-pilot go / no-go checklist

Decision status: `PENDING — simulator evidence is not a production launch decision`
Proposed pilot scope: ____________________ Decision meeting (UTC): ____________________ Chair: ____________________

The pilot is **NO-GO** if any required row is missing, expired, unsigned, contradicted, or owned by an unassigned person. A green simulator test cannot override an external gate.

## Current automated boundary (unsigned)

The real-app API rehearsal uses the disposable PostgreSQL service, simulator adapters, and production worker dispatch code. It has executable evidence for the public guarantor/applicant signature actions, deposit reconciliation and contract binding, posted-ledger/receipt replay, physical execution/handover/activation, settlement/ownership, worker restart/reclaim, and adverse fail-closed boundaries. The customer UI route also passes the local Playwright `channel: "chrome"` gate. This evidence is unsigned and does not constitute provider, hosting, restore, legal/privacy, security, or business sign-off; the overall decision remains **NO-GO/BLOCKED** until those external artifacts are supplied and signed. No production endpoint or real customer data may be used to close these rows.

Automated evidence reference: `apps/api/test/task15-controlled-pilot.e2e.test.ts` plus `test/e2e/information-request.spec.ts`, `payment-replay.spec.ts`, `recovery-control.spec.ts`, and `ownership-transfer.spec.ts` (real public HTTP); `test/load/application-flow.ts` (bounded simulator/PostgreSQL load, provider outage/recovery, and worker claim/restart/reclaim); `test/e2e/pilot-happy-path.spec.ts` (actual customer UI). External provider, hosting/capacity, backup/restore, penetration/security, and signed UAT gates remain pending.

| Gate                 | Required evidence                                                                                                                                                            | Status                  | Owner / expiry / evidence reference |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------- |
| Licence and tenure   | Current licence/approval proves every enabled tenure; disabled tenures remain blocked.                                                                                       | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Legal templates      | Approved contract/disclosure versions, hashes, and effective dates.                                                                                                          | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| DPC / DPIA / privacy | Approved DPIA, lawful basis, retention schedule, data-subject process, and cross-border review.                                                                              | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Consent              | Approved consent text/version and evidence that applicant and guarantor consent independently.                                                                               | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| NIA provider         | Somoco-provided provider documentation, sandbox evidence, SLA/outage behavior, credentials, and signed adapter contract tests.                                               | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| SMS provider         | Provider documentation, sender/OTP policy, delivery evidence, rate-limit behavior, and signed adapter contract tests.                                                        | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Payment provider     | Somoco USSD/Mobile Money webhook/signature/reconciliation evidence, settlement mapping, replay evidence, and signed adapter tests. Cash remains unavailable.                 | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Hosting / TLS        | Approved hosting design, private network/object storage, TLS certificate, origins, WAF/rate limits, and monitoring evidence.                                                 | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Secrets / access     | Secret-manager references, rotation, MFA, least privilege, break-glass authority, and production simulator prohibition.                                                      | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Backup / restore     | Signed restore rehearsal with measured RPO/RTO, restored-data integrity checks, and reconciliation result. Synthetic load output alone is insufficient.                      | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Security             | Threat-model review, dependency/security results, penetration test (where required), redacted logs, incident contacts, and accepted residual risk.                           | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Reconciliation       | Payment ledger/provider totals, unmatched queue, adjustment maker-checker, and settlement variance are clean.                                                                | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Training / staffing  | Named Verification Officer, BSM (initial/final), AGM, CFO, MD, Finance, Collections, Compliance, and Operations staff trained.                                               | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| UAT                  | Role-by-role script completed with signed evidence; no open critical/high defect.                                                                                            | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| Rollback readiness   | Admission stop, traffic rollback, worker drain, webhook preservation/replay, reconciliation, restore, communications, and authority chain rehearsed.                         | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |
| SAP discovery        | Product/version, source-of-truth matrix, approved interface/middleware, mappings, and test environment documented. **SAP synchronization stays OFF until this gate passes.** | ☐ PENDING ☐ PASS ☐ FAIL | ____________________                |

## Automatic no-go conditions

- Any simulator, synthetic connector, or test secret is configured in a production runtime.
- Any real pilot traffic is proposed before the NIA, SMS, payment, legal, privacy, hosting, TLS, secrets, backup/restore, security, reconciliation, training, and UAT rows are signed.
- Any critical/high defect remains open, any approval can be skipped, or any ownership/payment/audit invariant is unexplained.
- Any restore, capacity, penetration, provider, or staff-signature evidence is claimed without the actual signed artifact.
- SAP synchronization is enabled before discovery and source-of-truth approval.

## Decision and authority

Decision: ☐ GO for the explicitly scoped controlled pilot ☐ NO-GO ☐ BLOCKED pending evidence
Scope and traffic cap: ____________________ Start/stop authority: ____________________ Rollback authority: ____________________
Business sponsor: ____________________ Compliance/DPC: ____________________ Finance: ____________________ Operations: ____________________
Decision notes and evidence manifest: __________________________________________________

No row is pre-signed by this template. A GO decision must reference the signed evidence package and expiry dates.
