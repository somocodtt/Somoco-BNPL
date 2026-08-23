# Controlled-pilot threat model

The platform handles identity, financial, approval, contract, document, and
location-only tracking data. The threat model is a working control document;
independent security testing and Somoco approval remain release gates.

| Asset                  | Threat                                        | Control                                                                                                                     | Residual gate                         |
| ---------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| Customer sessions/OTP  | theft, replay, brute force                    | short-lived single-use OTP, rate limits, secure cookies, redacted logs                                                      | real SMS/MFA evidence                 |
| Ghana Card/documents   | disclosure, malware, public links             | private encrypted storage, malware scan, safe filenames, expiring tickets                                                   | approved storage/key/restore evidence |
| Ledger/approvals/audit | tampering, repudiation                        | DB constraints, append-only facts, role separation, immutable evidence                                                      | finance/security sign-off             |
| Provider webhooks      | spoofing, replay, outage                      | signature/integrity checks, inbox idempotency, durable acknowledgement, exception queue                                     | signed provider acceptance            |
| Staff console          | privilege escalation/CSRF                     | named accounts, MFA enforcement, server authorization, CSRF, secure headers                                                 | penetration test                      |
| Privacy lifecycle      | over-export, unauthorized correction/deletion | subject scope, compliance authorization, append-only amendments, legal holds, approved policy, immutable evidence retention | DPC/DPIA/legal approval               |
| Tracker/location       | stalking or over-collection                   | location-only deep link, recovery-role access, purpose/audit record, manual decisions                                       | approved tracker policy               |
| Operations             | outage/ransomware                             | encrypted backups, RPO 15m/RTO 4h, readiness, restore rehearsal                                                             | approved hosting/restore evidence     |

## Trust boundaries

The browser is untrusted; all authorization and validation occur in the API.
External providers are untrusted dependencies behind versioned adapters. The
database and object storage are private infrastructure boundaries. Workers
consume only durable outbox records and preserve correlation IDs without
copying bearer secrets.

## Release response

Any failed security, privacy, provider, hosting, restore, or finance gate keeps
the pilot paused. Manual recovery and legal decisions are recorded; there is no
automatic recovery, seizure, ownership transfer, or financial correction.
