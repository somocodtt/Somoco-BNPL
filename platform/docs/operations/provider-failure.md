# Provider failure runbook

Provider adapters fail closed and preserve a durable exception path. Provider
credentials, payloads, and personal data stay out of logs.

## Detection and containment

- Watch provider-failure counters, dependency readiness, delivery/acceptance
  rates, queue age, timeout rate, and payment reconciliation variance.
- Confirm the failure with the provider's approved status/support channel and
  record the provider reference without storing raw payloads.
- Pause only the affected workflow when safe. NIA outage may save an
  application draft but cannot mark identity verified. SMS stays queued and
  retries. Payment webhooks are durably recorded before acknowledgement and
  duplicates return the original outcome.

## Supervised recovery

1. Keep outbox messages and exception history; do not drop or replay blindly.
2. Retry with bounded backoff and a dead-letter/exception queue after the
   configured limit.
3. Finance staff reconcile settlement totals before any manual adjustment.
4. Recovery staff use the separate tracking platform for location-only data;
   every lookup has actor, case, purpose, and time. Do not enable automatic
   seizure, recovery, or ownership transfer.
5. Re-enable the adapter only after a support owner confirms health, a bounded
   acceptance scenario passes, and compliance/finance approve reopening.

Provider outage evidence does not satisfy the signed provider or hosting gate.
Synthetic adapters are permitted only in explicit test mode.
