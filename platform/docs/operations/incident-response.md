# Incident and breach response runbook

This procedure covers security, privacy, availability, and financial-integrity
incidents. It must be adapted and approved by Somoco's incident owner,
privacy/compliance lead, legal counsel, and finance owner before pilot use.

## First 15 minutes

1. Open an incident record with a correlation identifier, UTC time, reporter,
   severity, and affected environment.
2. Preserve logs, audit events, provider references, and immutable evidence;
   do not copy OTPs, passwords, identity numbers, payment values, or document
   contents into chat or tickets.
3. Contain the smallest safe scope: pause intake, revoke sessions/credentials,
   disable a provider, or isolate a host. Do not delete evidence.
4. Assign incident commander, security lead, privacy lead, technical lead, and
   communications owner. Record every decision and approver.

## Privacy breach

Identify subjects, data categories, processors, time window, and likely harm
without exporting unnecessary personal data. Notify the DPC, affected people,
providers, insurers, and other authorities only through the approved legal and
privacy process and within applicable deadlines. Rotate exposed secrets and
invalidate access links. A privacy request or correction must not be used to
rewrite immutable approval, payment, contract, or audit evidence.

## Recovery and closure

Validate containment, restore objectives, ledger/reconciliation variance,
outbox state, and provider acknowledgements. Security and compliance owners
must approve reopening intake. Capture root cause, control changes, evidence
hashes, notification decisions, and follow-up tests. Never describe a synthetic
fixture or local compose run as a production incident rehearsal.
