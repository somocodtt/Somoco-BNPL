# Backup and restore runbook

This runbook is an operational control for the controlled pilot. It is not
evidence that a hosting provider, backup service, or restore rehearsal has been
approved.

## Objectives

- Recovery point objective (RPO): no more than 15 minutes of committed data.
- Recovery time objective (RTO): restore service within 4 hours.
- Database point-in-time recovery and object-storage versioning are required.
- Backups are encrypted, access-controlled, geographically appropriate, and
  monitored by an owner who cannot silently alter the evidence.

## Backup checks

1. Confirm the latest database WAL/base-backup timestamp and object-storage
   version inventory from the approved hosting console.
2. Confirm encryption-key availability without printing key material.
3. Compare backup age with the 15-minute RPO and page the on-call owner if it
   is stale or incomplete.
4. Record a signed, environment-bound verification record. A timestamp alone
   is not a restore test.

## Restore rehearsal

1. Declare a change window and use an isolated restore target.
2. Restore the database and private object versions; never overwrite the live
   database during a rehearsal.
3. Apply migrations, verify ledger/audit append-only constraints, and compare
   row/control totals with the signed backup manifest.
4. Run liveness/readiness, payment idempotency, outbox replay, and safe export
   checks. Confirm no public bucket/object URLs are produced.
5. Measure elapsed restore time and recovered point. Keep the signed result,
   operator, environment, and exception list in the release evidence store.
6. Obtain finance/security sign-off before any recovery cutover.

If totals, signatures, encryption keys, or object versions do not match, stop
and keep the service paused. Recovery is a supervised manual decision; the
platform must not guess or post compensating financial entries automatically.
