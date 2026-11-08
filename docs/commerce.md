# Goose business operations

The customer workflow is inquiry, source intake, scoped proposal, customer approval, implementation, independent verification, delivery acceptance, invoice, payment status, support, and recurring delivery-integrity checks. The durable delivery state machine remains responsible for engineering decisions. Commerce links these stages without representing drafts, synthetic approvals, or test receipts as real customer outcomes.

## Entry points

- `/contact`: creates an inquiry and returns a source-intake link. A public inquiry UUID may be linked only to a job with the same customer email and demonstration/real classification.
- `/ops/business`: operator-authenticated inquiries, outbox, invoices, payment evidence, support, maintenance and integration readiness.
- Customer workspace: token-scoped payment checkout, support, fresh-source follow-up jobs, maintenance enrollment and cancellation.
- `serviceCommerce()`: call periodically from the worker. Creates deduplicated lifecycle messages and dispatches them under the operator's transactional policy. It also recovers interrupted outbound sends conservatively and reconnects interrupted follow-up job creation.
- `syncCommerceForJob(jobId)`: safe to invoke after a job transition or invoice creation.
- `runMaintenanceChecks()`: processes due plans with leases. It checks the hashes of the actual delivered package and frozen artifacts and the latest recorded verification verdict. A failure creates a bounded change request tied to the original job.

## Autonomous transactional communication

The policy is disabled by default. An operator can authorize it once in the business console, choosing test-only or real-and-test operation. This action records a founder intervention. The worker then sends ordinary proposal, delivery, invoice and support notifications without asking the founder to approve each message.

Policy dispatch selects only trusted lifecycle templates, only the email on the linked customer account, and only the permitted message purposes. It never dispatches prospecting drafts, arbitrary operator drafts, or messages addressed to an unrelated recipient. Test jobs always use the local receipt adapter and never send external email. With no provider credentials, real drafts remain waiting for setup.

Arbitrary outbound messages require authorization of the exact stored content. A content hash prevents a message being changed after review. A delivery timeout is marked uncertain and is not automatically retried. The operator must check the provider and reconcile the result, with that intervention recorded. Ordinary provider acceptance is recorded as acceptance, not a guarantee of recipient delivery.

## Email setup

For AgentMail, configure:

```
GOOSE_EMAIL_PROVIDER=agentmail
AGENTMAIL_API_KEY=...
AGENTMAIL_INBOX_ID=...
GOOSE_PUBLIC_URL=https://your-goose-host.example
```

Goose calls the documented `POST /v0/inboxes/{inbox_id}/messages/send` endpoint using bearer authentication and the `to`, `subject`, and `text` fields. It stores the returned `message_id`. See [AgentMail send-message reference](https://docs.agentmail.to/api-reference/inboxes/messages/send).

A custom delivery gateway can instead use `GOOSE_EMAIL_PROVIDER=webhook`, `GOOSE_EMAIL_WEBHOOK_URL` (HTTPS), and `GOOSE_EMAIL_WEBHOOK_TOKEN`. Goose sends `{idempotency_key,to,subject,text}` with bearer authentication; the gateway must return `{id}` or `{message_id}`. The gateway should enforce the idempotency key. Goose never assumes a failed network response proves a message was not sent.

For inbound email or another inquiry source, configure a gateway that POSTs to `/api/webhooks/inquiries` with `{event_id,name,email,organization,goal,repositoryUrl?,isTest?}`. Set `GOOSE_INQUIRY_WEBHOOK_SECRET`. The gateway signs the raw request body as HMAC-SHA256 over `<unix_timestamp>.<body>` and sends `X-Goose-Signature: t=<unix_timestamp>,v1=<hex_digest>`. Requests outside a five-minute window are rejected. The provider event ID and body hash deduplicate retries, including concurrent requests. This endpoint is a documented generic gateway interface, not a claim that native AgentMail webhooks have this schema.

## Payments

Configure `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and `GOOSE_PUBLIC_URL` to enable hosted Stripe Checkout. Live checkout requires HTTPS. A Stripe test session requires a Stripe test key; a real invoice requires a live key. Demonstration invoices use local test checkout if only live keys are configured. The application sends a one-time payment session with the exact invoice amount, currency, and invoice/job metadata. See [Stripe Checkout session creation](https://docs.stripe.com/api/checkout/sessions/create).

Configure `/api/webhooks/stripe` to receive `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and `checkout.session.expired`. Goose verifies the signature over the raw body before processing it, following [Stripe's webhook signature guidance](https://docs.stripe.com/webhooks/signature). Only a paid session registered to a Goose invoice with matching mode, amount, currency, and metadata can settle that invoice. Duplicate events and separate completion events for the same payment do not create duplicate revenue. A browser redirect never marks an invoice paid.

Without Stripe credentials, a demonstration invoice offers local test checkout. Explicit test settlement writes a payment labelled `local_test` and `is_test=true`. It never moves money. Real invoices remain unpaid until a valid real payment is recorded. Test payments are excluded from real-revenue totals.

## Support and follow-up work

Customer support requests use the existing Naïve coordinator reply path. Requests needing human judgment remain open. An explicit engineering change request gets its own record with a spending cap and parent-job link. The customer uploads a fresh source snapshot before a real child job is created. Its assessment, proposal, approval, verification and delivery are independent of the original job. Broad workspace jobs preserve their workspace execution mode. Customers can reopen the child workspace from the parent workspace after a reload.

## Current maintenance boundary

Maintenance enrollment schedules delivery-integrity checks. It does not automatically bill a recurring subscription, scan upstream package registries, rerun all runtime acceptance tests, monitor a production deployment, or automatically implement an upgrade. These boundaries appear in each recorded check. A failure creates a change request requiring fresh source and a new agreed proposal. No recurring revenue is claimed from enrollment.

## Verification

`tests/integration/commerce.test.ts` tests signature tampering and replay windows, concurrent inquiry deduplication and identity checks, message authorization, demo/real separation, payment amount/mode/metadata checks, concurrent settlement, support child-job creation, maintenance tamper detection, and one-time transactional policy dispatch. Run with the repository's isolated integration test runner. Provider calls are never made by these tests.

## Readiness and a complete local demonstration

Run `npm run doctor` for read-only checks of PostgreSQL, the current schema, operator access, Naïve account/model readiness and agent registry, native runtimes, optional ROS image, and provider activation. It prints no credentials and starts no model work. A missing optional email or payment key is reported as pending activation while the local test workflow remains usable. `npm run commerce:status` checks only configuration presence without contacting any provider or database.

Run `npm run commerce:demo -- GS-1001` against an existing verified synthetic delivery to exercise inquiry association, test-only transactional dispatch, test settlement, support and maintenance. The command preserves engineering artifacts, records no real revenue, and does not start a follow-up engineering job. Its trace explicitly separates the earlier live Naïve engineering work from the local commercial demonstration. See [recorded commerce evidence](evidence/commerce-live.md).

Support per-call model allowances are capped to the recorded remaining job budget, up to $0.50. There is not yet an atomic reservation across concurrent engineering and support sessions. Production operators should account for that concurrency boundary when configuring budgets.

## Native AgentMail incoming mail

AgentMail needs no custom gateway. Goose exposes `POST /api/webhooks/agentmail` for the documented `message.received` event and verifies the raw request with the official Svix library. Its `svix-id`, `svix-timestamp` and `svix-signature` headers are required; the library enforces the five-minute timestamp window. Goose deduplicates on the payload's `event_id`, which is stable across retries and subscriptions. See [AgentMail verification](https://docs.agentmail.to/webhook-verification), [received-message schema](https://docs.agentmail.to/api-reference/webhooks/events/message-received), and [Svix verification](https://docs.svix.com/receiving/verifying-payloads/how).

To activate:

1. Configure `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` for the Goose mailbox. Set `GOOSE_EMAIL_PROVIDER=agentmail` when outbound email is ready.
2. Expose Goose at an HTTPS `GOOSE_PUBLIC_URL`. In the AgentMail console create a webhook scoped to that inbox, using `https://your-goose-host/api/webhooks/agentmail` and event type `message.received`. The [inbox webhook API](https://docs.agentmail.to/api-reference/inboxes/webhooks/create) also supports registration.
3. Copy that endpoint's Svix signing secret into `AGENTMAIL_WEBHOOK_SECRET`. Do not use the API key as the signing secret.
4. Keep `AGENTMAIL_INBOUND_MODE=test` for synthetic inquiries. Select `live` explicitly for real incoming mail. Prefer separate inboxes and signing secrets for test and production. The sender cannot choose the mode through the payload.
5. Run `npm run db:migrate` and `npm run doctor`, restart the app and worker, then use AgentMail's console test delivery. Confirm the incoming receipt in the business console. Actual inbound email and outbound sending are independent; transactional outbound policy remains off for real sends until authorized.

Goose stores the sender, subject, plain body and HTML body exactly as received in a private receipt. The inquiry contains a plain-text preview. HTML is never rendered; long previews are marked as truncated. Only the configured inbox is accepted. Spam, blocked and unauthenticated variants are ignored, and ambiguous senders or missing inline bodies are held for operator review. AgentMail may omit bodies larger than 64 KiB and provide a temporary `body_url`; this receiver does not fetch those URLs or attachments. Review such messages in AgentMail before creating an intake.

A signed incoming message creates a new inquiry, never a customer-token session and never an automatic link to an existing private job. It starts no engineering work, sends no reply and makes no charge. The operator-only receipt API is `GET /api/commerce/inbound/[id]`, with private/no-store caching. Inquiries can then follow the normal source-upload and proposal workflow.

Seven native inbound tests use the documented payload shape and official Svix signing vector, covering concurrent duplicate events across distinct delivery IDs, content tampering, stale/future signatures, inbox and sender ambiguity, server-selected test/live mode, existing-customer isolation, private receipt access, HTML previews and omitted bodies. No real AgentMail delivery has been claimed before credentials are configured. The installed official Svix package requires Node 22 or later.
