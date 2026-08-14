# Somo BNPL Production Platform Design

Date: 2026-08-14  
Status: Approved conversational design; awaiting written-spec review  
Company: Somoco  
Product: Somo BNPL

## 1. Executive summary

Somoco will replace the current single-file demonstration with a secure production platform for financing Somoco-owned vehicles to individual customers under a buy-now-pay-later arrangement. Somoco supplies the vehicle, funds the financing, retains legal ownership, registration, and insurance during the payment term, and transfers ownership only after final settlement.

The approved architecture is a modular monolith: two mobile-responsive web applications, a structured TypeScript backend, PostgreSQL, encrypted object storage, background workers, and an integration gateway. This gives Somoco strong transactional integrity and security without the operational cost of premature microservices.

The first delivery milestone is a controlled production pilot within one month. It is not an unrestricted public launch. The pilot will serve approximately 25–50 monitored real applications and will be followed by hardening, legacy-data migration, additional integrations, and wider rollout.

The existing local and server prototypes are requirements references only. Their browser-side authorization, plaintext passcodes, simulated document handling, open storage API, and JSON-file persistence will not be carried into production.

## 2. Business decisions already approved

The design is based on the following confirmed decisions:

- Somoco funds and legally owns the customer financing.
- Somoco owns and supplies the vehicle inventory.
- The scheme serves individual customers only in phase one.
- Somoco currently operates one main head office for physical signing and vehicle handover.
- Expected first-year application volume is approximately 500–5,000 applications per month.
- Customers apply online through a mobile-first PWA.
- Applicants and guarantors complete and confirm their sections separately.
- Applicant and guarantor authentication uses phone-number SMS OTP.
- Both applicant and guarantor undergo NIA-approved Ghana Card verification.
- A vehicle model is selected during application; a specific chassis or VIN is assigned only after approval and verified deposit payment.
- The fixed approval chain is Verification Officer, BSM, AGM, CFO, BSM final review, then MD.
- Administrators define minimum deposits, permitted tenures, financing methods, and other product rules by vehicle model.
- Controlled exceptions require higher approval, a reason, and a permanent audit trail.
- Repayment frequency can be weekly or monthly.
- Permitted tenure choices are 6, 8, 12, 24, 36, and 48 months, subject to written confirmation that Somoco's licence permits each product.
- Financing can use flat markup or reducing-balance interest.
- Deposits and repayments are made through Somoco's existing USSD and Mobile Money payment integration.
- Cash is not accepted.
- Vehicles remain registered and insured in Somoco's name until ownership transfer.
- Vehicle tracking supplies location only and is initially accessed through a separate platform.
- Both consecutive missed installments and total unpaid installments are reported.
- Three missed installments create an escalation flag, but an authorized administrator decides whether recovery action should start.
- Vehicle location lookup, recovery decisions, seizure, and ownership transfer are never automatic.
- Customers and guarantors consent and sign online, then physically sign the final agreement at head office.
- Existing records are held in Excel and paper files.
- New online applications may launch while legacy records are migrated in controlled batches.
- SAP ERP integration must be possible through a direct connector or middleware.

## 3. Goals

The platform will:

1. Provide a secure, mobile-first application experience for applicants and guarantors.
2. Digitize identity, KYC, document, consent, underwriting, and approval evidence.
3. Enforce Somoco's real approval sequence and separation of duties.
4. Configure and version financing products by vehicle model.
5. Produce accurate, auditable offers and repayment schedules.
6. Integrate NIA verification, SMS, Somoco payments, vehicle tracking, future credit-bureau services, and SAP.
7. Manage vehicle assignment, contract execution, handover, registration, insurance, tracking, and ownership transfer.
8. Maintain an immutable payment subledger and reliable provider reconciliation.
9. Monitor arrears and support controlled collections and recovery decisions.
10. Migrate legacy customers and contracts without blocking new applications.
11. Meet the security, privacy, audit, resilience, and operational requirements expected of a production financial platform.

## 4. Phase-one non-goals

The controlled pilot will not include:

- Native Android or iOS applications.
- Business or fleet-customer onboarding.
- Cash collection.
- Automatic loan approval.
- Automatic credit-bureau API checks.
- Automatic vehicle immobilization, seizure, or repossession.
- Broad public marketing or unrestricted applicant volume.
- Full legacy-paper-file transcription.
- Guaranteed SAP synchronization before SAP technical discovery is completed.
- Embedded tracker location before tracker API access is approved and tested.
- Any financing product that the MD, compliance lead, and legal counsel have not confirmed is permitted.

## 5. Architecture

### 5.1 Applications

Customer and guarantor PWA:

- Responsive, installable web application optimized for low-cost mobile devices and unstable connections.
- Automatic draft saving, safe resume across sessions, and upload progress with retry.
- Image compression and bandwidth-conscious document capture without reducing evidence below approved quality.
- Phone-number registration and SMS OTP.
- Applicant and guarantor onboarding.
- NIA identity verification.
- Document capture and upload.
- Online consent and signature evidence.
- Application progress and status.
- Offer review and acceptance.
- Contract, schedule, payment instructions, balances, and receipts.
- Secure support and information-request responses.

Staff operations portal:

- Role-specific queues and dashboards.
- Verification and underwriting.
- Approval decisions and exception approvals.
- Product and vehicle-model configuration.
- Vehicle-unit assignment and handover.
- Contract execution and document management.
- Payment reconciliation and adjustments.
- Arrears and recovery case management.
- Insurance, registration, tracking, and ownership transfer.
- Reporting, audit, migration, and integration operations.

### 5.2 Backend

The backend will be a modular TypeScript service with explicit module boundaries:

- Identity and access
- People and customer profiles
- Applications and guarantors
- Identity and KYC verification
- Documents, consent, and signatures
- Underwriting and affordability
- Approval workflow
- Products and financing rules
- Offers and calculations
- Contracts
- Vehicle inventory and asset lifecycle
- Payments and financial ledger
- Collections and recovery
- Notifications
- Reporting
- Integration gateway
- Legacy migration
- Administration and audit

The application API and background worker may deploy separately while sharing the same domain modules and database. This preserves modularity without adopting microservices prematurely.

### 5.3 Persistence and infrastructure

- PostgreSQL is the transactional system of record for the operational platform.
- Encrypted object storage holds identity documents, statements, photographs, signed contracts, and legacy scans.
- A durable queue processes notifications, provider calls, reports, synchronization, and retries.
- A transactional outbox records external events in the same database transaction as business changes.
- Approved Somoco infrastructure hosts separate development, test, and production environments.
- The database and object storage are private and cannot be accessed directly from the public internet.
- HTTPS, a reverse proxy or load balancer, firewall or WAF, centralized secrets, monitoring, and encrypted backups are mandatory.

### 5.4 Technology constraints

- The client and server use typed contracts.
- Public, staff, and integration APIs are versioned.
- All business rules execute on the server.
- Client-side validation improves usability but is never trusted as authorization or final validation.
- Framework and library selection must fit Somoco's approved hosting runtime and will be finalized in the implementation plan.
- The system must not depend on runtime-loaded public CDN scripts for critical production functionality.

## 6. Core workflow

### 6.1 Application and guarantor

1. The applicant authenticates with phone number and SMS OTP.
2. The applicant selects a vehicle model, not a specific unit.
3. The applicant completes personal, occupation, workplace, contact, residential, GPS, landmark, affordability, and product information.
4. The applicant completes NIA verification.
5. The applicant uploads required evidence and signs the online declaration.
6. The applicant supplies the guarantor's phone number and sends an invitation.
7. The guarantor receives a single-use, expiring SMS link.
8. The guarantor authenticates independently, reviews the disclosed application context, provides their information, completes NIA verification, uploads evidence, and signs.
9. The application remains incomplete until all mandatory applicant and guarantor requirements are satisfied.
10. Submission creates an immutable application version and enters the Verification Officer queue.

The initial document catalogue is based on Somoco's current paper form and prototype. It includes Ghana Card evidence, applicant and guarantor passport photographs, rider or driver's licence where applicable, relevant association membership evidence such as ORAG or NUTOG where required, income evidence, bank or Mobile Money statements, residential evidence, and signed declarations. Administrators can configure requirements by product, but changes apply prospectively and cannot remove evidence from an existing submitted version.

### 6.2 Underwriting and approvals

Underwriting combines:

- Configured eligibility and affordability rules.
- Bank or Mobile Money statement evidence.
- NIA results.
- Manual credit-bureau result and evidence during phase one.
- Verification Officer review.
- Staff analysis and recommendation.
- Management judgment through the fixed approval chain.

The enforced approval sequence is:

1. Verification Officer
2. BSM initial review
3. AGM
4. CFO
5. BSM final review
6. MD final approval

Each stage can perform only the actions allowed by policy. Information requests, rejections, approvals, notes, timestamps, and actor identity are retained. A returned application creates a new applicant-submitted version without deleting prior evidence or decisions.

### 6.3 Offer and financing rules

Each vehicle model has effective-dated rule versions containing:

- Selling price
- Minimum deposit
- Allowed repayment frequencies
- Allowed tenures
- Allowed calculation method
- Rate or markup configuration
- Fees permitted by policy
- Eligibility thresholds
- Required evidence
- Exception limits and required approver

The platform supports:

- Flat markup on the financed principal.
- Reducing-balance interest.
- Weekly and monthly schedules.
- Tenures of 6, 8, 12, 24, 36, and 48 months where legally permitted.

Before either calculation method is enabled in production, Finance and Compliance must approve worked examples covering principal, rate basis, fees, installment amount, total cost, payment-allocation order, partial and excess payments, prepayment or early settlement, late payments, final-installment rounding, and customer disclosures. Those examples become automated acceptance tests.

Accepted offers are versioned and locked. Later product changes cannot alter an accepted offer or active contract. A requested exception records the proposed value, policy value, reason, requester, approving authority, and final decision.

### 6.4 Deposit, assignment, contract, and handover

1. An MD-approved applicant accepts the offer.
2. The customer receives USSD and Mobile Money deposit instructions.
3. Somoco's payment integration confirms the deposit through an authenticated webhook.
4. The payment enters the ledger and passes reconciliation controls.
5. Only after confirmed deposit may authorized inventory staff assign a specific vehicle unit.
6. Assignment records chassis or VIN, engine or motor identifier, tracker identifier, registration, insurance, condition, accessories, and handover details.
7. The system generates the final agreement from the locked offer and assigned asset.
8. Applicant and guarantor sign the physical agreement at head office.
9. Staff scan the executed agreement and record the signing officer, witnesses, date, and document hash.
10. Handover requires a completed checklist and authorized release.
11. The contract becomes active and the first due date is established.

### 6.5 Repayments and ledger

- All deposits and repayments arrive through Somoco's USSD and Mobile Money integration.
- Cash is not accepted or represented in the system.
- Authenticated webhooks carry the provider transaction reference and idempotency key.
- Duplicate callbacks return the original result and never post a second payment.
- Matched transactions create immutable ledger entries and allocate funds according to the contract's versioned, Finance-approved allocation policy.
- No default allocation order, early-settlement treatment, or overpayment behavior is enabled until Finance and Compliance approve the relevant worked examples.
- Unmatched, reversed, short, excess, or ambiguous transactions enter reconciliation.
- Electronic receipts are sent by SMS and remain available in the customer portal.
- Posted transactions are never edited or deleted.
- Corrections use linked reversal and adjustment entries with maker-checker approval.
- Schedules preserve the contractual total; any rounding residual is applied to the final installment.

### 6.6 Arrears and recovery

- The system reports consecutive missed installments and total unpaid installments independently.
- SMS reminders and warnings include a secure link to the account and current USSD payment instructions.
- Reaching three consecutive missed installments or three total unpaid installments creates an escalation flag.
- The flag does not automatically start recovery.
- An authorized administrator reviews account history, communication, promises to pay, location availability, and applicable notices before deciding.
- Recovery cases record the decision, reason, approvals, notices, assigned officer, location lookups, visits, actions, condition of a recovered vehicle, and outcome.
- Tracker access is location-only, restricted, and audited.
- The platform never remotely immobilizes a vehicle.
- Seizure or repossession is never initiated automatically.

### 6.7 Settlement and ownership transfer

Final settlement requires:

- All due principal, financing charges, and approved fees accounted for.
- No unresolved reversals, chargebacks, or unmatched payments.
- Finance reconciliation approval.
- Confirmation of vehicle and contract status.
- Authorized ownership-transfer approval.

The platform produces an ownership-transfer pack, records execution, and preserves evidence that registration and insurance were changed. The vehicle remains a Somoco-owned asset until this workflow completes.

## 7. Roles and separation of duties

Customer-facing roles:

- Applicant
- Guarantor

Staff roles:

- Verification Officer
- BSM
- AGM
- CFO
- MD
- Product and financing administrator
- Inventory and handover officer
- Finance and payment-reconciliation officer
- Collections and recovery officer
- Compliance and auditor
- Customer-support officer
- Technical system administrator

Rules:

- Every user has a named account; shared accounts and role passcodes are prohibited.
- Staff authentication requires a strong credential and MFA.
- Access uses least privilege and defaults to deny.
- Temporary delegation is time-limited, scoped, approved, and audited.
- Technical administrators do not receive business-approval or ledger-edit permissions by default.
- Product administrators cannot approve their own rule exception.
- Payment adjustments and reversals require separate maker and checker.
- Recovery staff cannot authorize their own recovery action.
- Ownership transfer requires finance reconciliation and authorized business approval.
- Compliance and auditors have read-only evidence and export access.
- Privileged role changes generate alerts and periodic access-review tasks.

## 8. Data model and integrity

Principal entities include:

- Person
- Customer profile
- Guarantor relationship
- Application
- Application version
- Identity check
- Document
- Consent
- Signature evidence
- Underwriting assessment
- Approval decision
- Product and vehicle model
- Financing-rule version
- Exception request
- Offer and offer version
- Contract
- Vehicle unit
- Vehicle assignment
- Insurance record
- Registration record
- Tracker association and access log
- Handover record
- Repayment schedule
- Installment
- Payment transaction
- Ledger entry
- Reconciliation case
- Notification and delivery attempt
- Arrears snapshot
- Recovery case
- Ownership transfer
- Audit event
- Integration message
- Migration batch and migration record

Controlled state machines reject invalid transitions. Examples include assigning a vehicle before approval and deposit, activating a contract without executed-document evidence, posting a duplicate payment, or transferring ownership before settlement.

Money uses a fixed decimal or minor-unit representation appropriate to Ghana cedi. Binary floating-point arithmetic is prohibited for contractual calculations.

Sensitive identity and document data are isolated from general operational data so permissions and retention can be stricter.

## 9. Integration architecture

All providers connect through a versioned adapter contract. Provider-specific request fields, credentials, and error codes do not leak into domain modules.

### 9.1 NIA verification

- Used for applicant and guarantor.
- Records the minimum decision, provider reference, timestamp, and evidence required for audit.
- Does not retain unnecessary biometric data.
- If unavailable, the application can be saved but cannot be marked identity-verified.
- Provider documentation, test access, production credentials, consent language, and retention rules are required before pilot launch.

### 9.2 SMS

- Sends OTPs, invitation links, information requests, decisions, payment instructions, receipts, reminders, and arrears warnings.
- Records provider message reference and delivery state.
- OTPs are short-lived, single-use, rate-limited, and never logged in plaintext.
- Failed messages retry and appear in an operations exception queue.

### 9.3 Somoco payment integration

- Receives authenticated and integrity-checked webhooks.
- Requires provider transaction reference, amount, currency, payer reference, event type, timestamp, and idempotency key.
- Handles success, reversal, refund, settlement, and correction events supported by the provider.
- Uses reconciliation files or APIs to compare the internal subledger with provider settlement.
- A webhook is acknowledged only after it is durably recorded.
- Provider documentation and sandbox scenarios are mandatory before pilot launch.

### 9.4 Vehicle tracking

- Initially provides a secure deep link to the separate tracking platform.
- A future read-only adapter may display last known location, timestamp, and device status.
- Only authorized recovery roles can view location.
- Every lookup records actor, case, purpose, and time.

### 9.5 Credit bureau

- Phase one records a manual check, result, date, officer, bureau reference, and evidence.
- A future adapter automates requests and results without changing the approval model.
- Automated results never independently approve or reject an applicant.

### 9.6 SAP ERP

The integration gateway supports either a direct SAP connector or middleware. SAP discovery must establish:

- Exact SAP product and version.
- Available interfaces and authentication.
- Whether approved middleware is required.
- Network and data-location constraints.
- Source of truth for customer, vehicle, inventory, contract, payment, and accounting records.
- Chart-of-accounts and cost-centre mappings.
- Master-data identifiers and duplicate rules.
- Posting, reversal, settlement, and reconciliation behavior.
- Required frequency, latency, and support ownership.

Candidate outbound business events include:

- Customer approved
- Offer accepted
- Deposit confirmed
- Vehicle assigned
- Contract activated
- Payment posted
- Payment reversed
- Account delinquent
- Vehicle recovered
- Contract settled
- Ownership transferred

The transactional outbox preserves these events until the chosen connector confirms delivery. SAP unavailability does not discard or roll back a valid Somo transaction. Failed events retry, then move to a supervised exception queue.

Bidirectional synchronization will not be enabled until Somoco approves a source-of-truth matrix. Until SAP discovery is complete, the production platform remains the operational source of truth for application workflow, contract state, and the repayment subledger.

## 10. Error handling and resilience

User-facing errors provide a safe explanation, next action, and support reference. Stack traces, provider payloads, secrets, and internal identifiers are not exposed.

Integration failure behavior:

- NIA unavailable: save progress, retry, and prevent verified status.
- SMS unavailable: queue, retry, and alert on sustained failure.
- Payment duplicate: return the original outcome without a second posting.
- Payment unmatched: place in reconciliation without guessing.
- SAP unavailable: retain outbox events and synchronize later.
- Tracker unavailable: show last-known timestamp and allow authorized external-platform access.
- Credit bureau unavailable: retain the manual phase-one workflow.
- Repeated failure: move to a dead-letter or exception queue with complete history and controlled resolution.

Operational resilience:

- Point-in-time database recovery where supported.
- Encrypted, geographically appropriate backups.
- Automated backup monitoring.
- Regular restore tests.
- Minimum pilot recovery-point objective of 15 minutes.
- Minimum pilot recovery-time objective of 4 hours.
- Graceful application shutdown and safe job retry.
- Correlation identifiers across web requests, jobs, and provider calls.
- Health, dependency, capacity, error-rate, queue-age, and reconciliation monitoring.

Service and performance requirements:

- Capacity tests must demonstrate operation above 5,000 applications per month with expected staff usage and scheduled background work.
- Normal first-party API requests should complete within two seconds at the 95th percentile under the approved load profile, excluding time spent waiting for an external provider.
- Long-running exports, migration, reconciliation, and synchronization run as background jobs and never hold an interactive browser request open.
- Customer drafts survive a browser refresh, temporary disconnection, or recoverable provider outage.
- Public and staff interfaces support current major mobile and desktop browsers and meet the accessibility standard approved by Somoco for launch.

## 11. Security and privacy

Mandatory controls include:

- Server-enforced authorization for every protected operation.
- Staff MFA and named accounts.
- Secure, short-lived customer sessions after OTP.
- Strong password hashing for staff credentials.
- Brute-force, OTP, enumeration, and rate-limit protection.
- Encryption in transit, at rest, and in backups.
- Centralized secret management and credential rotation.
- File-size and type validation, malware scanning, safe filenames, encryption, and expiring access links.
- Content Security Policy and safe output encoding to prevent stored cross-site scripting.
- CSRF protection where cookie-based sessions are used.
- Secure headers, dependency scanning, vulnerability management, and patch procedures.
- Append-only audit events recording actor, action, reason, time, source, and before/after values where appropriate.
- Privileged-access review and segregation of duties.
- Privacy notices and recorded consent for applicant and guarantor.
- Data minimization, purpose limitation, retention, correction, access, deletion or restriction processes as legally applicable.
- Incident-response and breach-reporting procedures.
- Independent penetration testing before wider release.

Somoco's DPC registration and privacy program must cover the new processing. A Data Protection Impact Assessment is required before the pilot because the platform processes identity, financial, location, and profiling information.

Current official references include:

- Bank of Ghana Digital Credit Services Provider information: https://www.bog.gov.gh/fintech-innovation/licence-categories/
- Bank of Ghana licensing requirements: https://www.bog.gov.gh/fintech-innovation/licence-requirements/
- Ghana Data Protection Commission registration guidance: https://dataprotection.org.gh/registration/
- Ghana Data Protection Commission compliance and DPIA guidance: https://dataprotection.org.gh/compliance/
- Ghana Data Protection Commission organisational guidance: https://dataprotection.org.gh/for-organisations/

This specification is not a substitute for Ghanaian legal advice. The MD, compliance lead, and Somoco's lawyer must provide written product and process approval.

## 12. Reporting and dashboards

Operational reporting includes:

- Applications by stage, age, product, and outcome.
- Information-request and approval turnaround time.
- Verification and NIA exception queues.
- Underwriting and rule-exception reports.
- Approved offers awaiting deposit.
- Deposits awaiting reconciliation.
- Available, assigned, handed-over, recovered, and transferred vehicles.
- Active contracts by model, tenure, frequency, and calculation method.
- Scheduled, paid, outstanding, overdue, reversed, and unmatched amounts.
- Consecutive missed installments.
- Total unpaid installments.
- Accounts at or above the three-payment escalation threshold.
- Recovery cases and outcomes.
- Provider delivery and integration failures.
- SAP synchronization and reconciliation state.
- Access, privilege, and audit reports.
- Migration batch totals and exceptions.

Reports containing personal or financial data enforce the same authorization as screens. Exports are watermarked or attributable to the requesting user and recorded in the audit trail.

## 13. Legacy migration

New online applications may launch before migration is complete.

Excel migration:

- Somoco data is mapped into a versioned import template.
- Each row is validated before import.
- Duplicates are checked using Ghana Card, phone, contract reference, vehicle identifier, and approved matching rules.
- Ambiguous matches are never merged automatically.
- Batch totals for contracts, principal, paid amount, outstanding amount, and arrears are reconciled.
- Finance approves each batch before activation.

Paper migration:

- Staff enter essential structured data only: customer, guarantor, contract, vehicle, current balance, arrears, and repayment history.
- The complete legacy paper file is scanned as a controlled attachment.
- Data entry and verification are performed by different staff members.

Migration controls:

- Original legacy identifiers are preserved.
- Imported records are marked with provenance and batch identifier.
- Records remain quarantined or read-only until validation and finance approval.
- Imports are idempotent and safe to rerun.
- Failed rows produce a clear exception report.
- Migration never silently overwrites a live production record.

## 14. Testing strategy

Automated unit tests cover:

- Flat-markup and reducing-balance calculations.
- Weekly and monthly schedules.
- All permitted tenures.
- Final-installment rounding.
- Deposits, reversals, adjustments, and allocation.
- Arrears and both missed-installment measures.
- Role and separation-of-duty rules.
- State transitions and exception approvals.

Integration tests cover:

- PostgreSQL transactions and outbox behavior.
- Object storage and access expiry.
- NIA adapter.
- SMS OTP and delivery callbacks.
- Payment webhooks, retries, duplicates, reversals, and reconciliation.
- SAP adapter contract with a simulator until the real environment is available.
- Tracker and credit-bureau adapter boundaries.

End-to-end tests cover:

- Applicant and guarantor completion.
- Information request and resubmission.
- Full approval chain.
- Offer acceptance and deposit.
- Vehicle assignment and physical contract.
- Handover and contract activation.
- Repayment, receipt, reversal, arrears, and recovery escalation.
- Settlement and ownership transfer.
- Legacy import and reconciliation.

Non-functional testing includes:

- Authorization and privilege-escalation testing.
- File-upload and malware-control testing.
- OTP abuse and rate-limit testing.
- Dependency and secret scanning.
- Independent penetration testing.
- Backup restoration.
- Failure and retry exercises for every external provider.
- Load tests exceeding 5,000 applications per month and expected staff concurrency.
- Mobile usability and accessibility testing.
- User acceptance testing by every staff role.

## 15. Four-week controlled pilot

The schedule is conditional on immediate access to provider documentation, test credentials, approved infrastructure, business owners, and daily decision-makers.

Week 1:

- Establish project structure and environments.
- Implement identity, roles, database, object storage, audit, and core application records.
- Confirm provider contracts and worked financing examples.
- Complete threat model and migration template.

Week 2:

- Implement applicant and guarantor PWA flows.
- Implement NIA, documents, consent, and SMS OTP.
- Implement staff queues and fixed approval chain.
- Begin role-based user acceptance testing.

Week 3:

- Implement product rules, offers, schedules, contracts, vehicle assignment, and handover.
- Integrate deposit and repayment webhooks, ledger, receipts, and reconciliation.
- Implement core dashboards, arrears measures, and exception queues.
- Conduct integration, migration, and end-to-end rehearsals.

Week 4:

- Resolve UAT and security findings.
- Complete backup and restoration rehearsal.
- Complete compliance, legal, and operational readiness checks.
- Run production smoke tests.
- Admit approximately 25–50 monitored real applications.
- Review operations daily and pause intake if a safety gate fails.

Pilot exit criteria:

- No unresolved critical security finding.
- No unexplained ledger or settlement variance.
- Full audit evidence for every pilot decision and payment.
- Successful restore test.
- Acceptable NIA, SMS, and payment delivery rates.
- Staff completion of assigned UAT and training.
- Compliance and MD approval for wider release.

## 16. Launch gates and accountable evidence

Licence gate:

- Owner: MD and compliance lead.
- Evidence: written confirmation of the exact Bank of Ghana licence category, permitted products, customer type, financing methods, fees, and tenures.
- Consequence: any unconfirmed product or tenure remains disabled.

Legal gate:

- Owner: Somoco's Ghanaian legal counsel.
- Evidence: approved online consent, guarantor consent, final contract, customer disclosures, notices, title-retention procedure, recovery procedure, and ownership-transfer process.
- Consequence: affected workflow cannot accept real customers.

Privacy gate:

- Owner: data-protection and compliance lead.
- Evidence: current DPC registration, DPIA, privacy notice, consent text, retention schedule, processor agreements, and breach procedure.
- Consequence: real personal-data collection does not begin.

Provider gate:

- Owner: Somoco technical lead and each provider owner.
- Evidence: NIA, SMS, and payment documentation; sandbox and production access; security requirements; support contacts; successful acceptance scenarios.
- Consequence: the real pilot cannot depend on an unverified provider.

Hosting gate:

- Owner: Somoco infrastructure and security owners.
- Evidence: environment specifications, network design, access, TLS, secrets, backups, monitoring, restore result, and deployment process.
- Consequence: no production deployment.

Finance calculation gate:

- Owner: CFO or delegated finance owner and compliance.
- Evidence: signed worked examples for flat markup and reducing-balance calculations, fees, disclosures, weekly and monthly schedules, all enabled tenures, allocation order, partial and excess payments, prepayment or early settlement, late payments, and rounding.
- Consequence: unapproved calculation configurations remain disabled.

SAP discovery gate:

- Owner: Somoco SAP owner and technical lead.
- Evidence: product/version, interface options, middleware decision, source-of-truth matrix, mappings, accounting examples, and test environment.
- Consequence: SAP synchronization remains disabled while durable domain events continue to be retained for later integration.

Tracker discovery gate:

- Owner: recovery and technical leads.
- Evidence: provider/API details, authorization, data fields, retention rules, and approved location-access policy.
- Consequence: authorized staff use the external tracker platform and record recovery actions manually.

Legacy migration gate:

- Owner: finance and operations.
- Evidence: approved import mapping, reconciled batch totals, sampling results, and signed activation.
- Consequence: failed or unapproved batches remain quarantined.

## 17. Success measures

The pilot is successful when:

- Applicants and guarantors can complete the full process on common mobile browsers.
- Every submitted application has complete identity, consent, and document evidence.
- The system enforces the approval sequence and role boundaries.
- Offers and schedules reproduce Finance-approved examples exactly.
- Every confirmed payment has one and only one ledger posting.
- Provider and ledger settlement totals reconcile.
- Staff can identify consecutive and total missed installments.
- No recovery or ownership action can occur automatically.
- All sensitive access and business decisions are auditable.
- Backups restore within the approved recovery objectives.
- Pilot users complete role-based UAT.
- Compliance, Finance, Operations, Security, and the MD approve progression to wider rollout.

## 18. Post-pilot sequence

After the controlled pilot:

1. Resolve pilot findings and complete independent penetration remediation.
2. Expand applicant volume gradually.
3. Run reconciled legacy Excel and paper migration batches.
4. Complete SAP discovery and implement the selected direct or middleware connector.
5. Add read-only tracker API integration.
6. Add credit-bureau API integration.
7. Extend regulatory and management reporting.
8. Review availability, support, disaster recovery, and scaling before unrestricted public launch.

## 19. Final design decision

Somoco will build a new modular production platform rather than harden the prototype or begin with microservices. The one-month objective is a controlled pilot. Security, licensing, legal, privacy, payment integrity, and restore readiness are release gates, not optional enhancements.
