# Controlled-pilot rollback runbook

Status: `PENDING — rehearse and sign with Somoco operations before any pilot traffic`
Run ID: ____________________ Trigger time (UTC): ____________________ Incident commander: ____________________

Rollback is a controlled stop and recovery of service. Never delete financial, approval, payment, personal-data-request, or audit evidence to make a rollback appear clean.

## Rehearsal evidence status

This runbook is an unsigned control template. The bounded load output is labelled `SIMULATED_PROXY` and measures request latency against disposable PostgreSQL and simulator adapters only; it is not queue-age, worker-restart/reclaim, provider-resilience, hosting-capacity, or restore-integrity evidence. Those checks remain `PENDING_EXTERNAL_REHEARSAL`. The real-app API tests also leave the pilot blocked where no public guarantor-signature or deposit-reconciliation-before-contract boundary exists. Do not close those gaps by writing workflow tables, replaying against production, or deleting evidence.

## Trigger and authority

Trigger immediately for duplicate/misallocated ledger entries, unauthorized access/action, skipped approval, wrong ownership, data disclosure, provider signature failure, unreconciled settlement, material outage, or any critical/high UAT defect. The Incident Commander may stop admission; the named Business Sponsor and Operations/Finance authorities approve resumption. If authority is unavailable, fail closed and keep traffic stopped.

## Sequence

1. **Stop admission.** Disable new applications and offer acceptance at the edge; show a neutral maintenance message. Do not erase drafts or customer evidence. Preserve the last known build/config hash.
2. **Rollback traffic.** Route traffic to the last approved immutable artifact or maintenance boundary. Verify TLS, origin allow-list, session invalidation policy, and staff MFA. Do not route to an unreviewed simulator or ad-hoc host.
3. **Pause and drain workers.** Stop admission of new jobs, pause dispatch, allow safe in-flight work to finish or mark it reclaimable, record queue IDs/attempts, and prevent duplicate sends. Resume only after dependency health and reconciliation checks pass.
4. **Preserve payment webhooks.** Keep receiving signed webhook envelopes if the provider contract permits; otherwise return a safe retry response. Store raw evidence, event IDs, provider transaction IDs, signature/timestamp result, and receipt time. Never drop, edit, or acknowledge an event as posted without the ledger result.
5. **Replay and reconcile.** Replay preserved events through the idempotent inbox after the boundary is healthy. Compare event, inbox, ledger, receipt, settlement, and unmatched/reversal counts. Route unknown references to reconciliation; never guess an allocation. Obtain Finance maker-checker approval for corrections.
6. **Protect immutable evidence.** Seal the audit/evidence manifest and hash it. Retain contract versions, signatures, documents, malware results, payment raw bytes, receipts, decisions, and rollback logs. Restrict access to the incident authority chain and record every lookup.
7. **Restore only with signed authority.** If data recovery is required, use the approved backup and restore procedure. Validate schema/migrations, row/control totals, audit-chain continuity, document/object references, ledger/receipt/reconciliation invariants, and RPO/RTO. A simulator run is not restore evidence.
8. **Communicate.** Incident Commander records the timeline; Operations notifies staff; Finance owns payment/reconciliation communication; Compliance owns privacy/regulatory notification assessment; Customer Support uses approved neutral messaging; the Business Sponsor approves external communication.
9. **Resume or remain stopped.** Resume only after a fresh readiness check, worker reclaim check, webhook replay/reconciliation sign-off, security review, and authority approval. If any check is unresolved, remain blocked and keep evidence preserved.

## Recovery targets and sign-off

Target RPO: __________ Target RTO: __________ Actual RPO/RTO: __________ Queue drained at: __________
Last accepted application/event: ____________________ Preserved webhook count/hash manifest: ____________________
Ledger/provider variance: ____________________ Unmatched cases: ____________________ Restore validation reference: ____________________

| Authority          | Required confirmation                                               | Name / time / signature |
| ------------------ | ------------------------------------------------------------------- | ----------------------- |
| Incident Commander | Admission stopped, traffic safe, timeline and evidence protected    | ____________________    |
| Operations         | Workers paused/drained/reclaimed; approved artifact/config restored | ____________________    |
| Finance            | Webhook replay and ledger/receipt/settlement reconciliation clean   | ____________________    |
| Compliance         | Privacy/security impact assessed; holds/notifications recorded      | ____________________    |
| Business Sponsor   | Scope, communications, and resume/continued-stop decision approved  | ____________________    |

Post-incident actions, owners, and due dates: ________________________________________________________________
