# Commercial workflow evidence, November 7, 2026

The commercial lifecycle was exercised against **GS-1001**, an already completed broad workspace engineering job. Its separately recorded live Naïve implementation had **16 of 16 mandatory checks passing**. This exercise preserved the delivered package and all frozen engineering evidence.

This was a **synthetic customer scenario**. The commerce demonstration ran in local mode, used local email receipts and a TEST invoice, and made no additional model calls. It demonstrates executable commercial operations around an actual verified delivery. It does not establish customer acquisition, production deployment, real email delivery or paid demand.

## Observed results

| Operation | Recorded result |
| --- | --- |
| Inquiry | Synthetic inquiry linked to GS-1001 with matching customer identity |
| Transactional policy | Enabled for test-only messages; real sending remained disabled |
| Delivery, invoice and support notifications | Durable outbox records dispatched with `provider=local_test` under the policy |
| Checkout | Local test checkout; no Stripe request |
| Settlement | One **$1,100 TEST payment**, `is_test=true`, `method=local_test`; **$0 real money moved** |
| Retry | Repeating the commercial workflow reported `duplicate=true` and retained one payment |
| Support | Delivery-evidence question resolved through an explicitly labelled local support response |
| Follow-up work | Separate capped change request recorded, awaiting a fresh source snapshot; no child engineering job started |
| Maintenance | Actual delivered-package and frozen-evidence hashes checked; verdict passed |
| Engineering evidence | Original package unchanged; existing 16/16 verification retained |

The first run completed at `2026-11-07T23:46:37Z`. The repeat at `2026-11-07T23:56:17Z` also verified an upgrade for invoice drafts created before transactional message purposes were introduced. Those known invoice templates became eligible for the opt-in transactional policy; arbitrary operator drafts remain manual.

The sanitized traces are in `var/evidence/commerce-GS-1001-first-run.json` and `var/evidence/commerce-GS-1001.json` in the running checkout. They omit customer workspace tokens, email addresses, provider keys, and database connection strings. The underlying company event log retains authorizations and provenance.

## Reproduce

```
npm run doctor
npm run commerce:status
npm run commerce:demo -- GS-1001
```

The demonstration command requires an existing verified demonstration delivery with a TEST invoice and synthetic customer contact. It refuses real jobs and configured Stripe connectivity, forces local commerce execution, and does not modify source or delivered artifacts. It leaves the transactional policy enabled for test messages only. The operator may disable it in the business console.

## Provider contracts and authorization checks

The current provider integration is checked using mocked HTTP calls and real local database state. No provider credentials were needed for these tests.

- AgentMail requests use the documented inbox send endpoint, bearer authentication and `to`, `subject`, `text` fields. The adapter captures `message_id`; HTTP failures and missing receipts do not become successful sends. [AgentMail reference](https://docs.agentmail.to/api-reference/inboxes/messages/send)
- Stripe session requests carry exact integer invoice amounts, currency, invoice/job metadata and stable idempotency keys. A real key cannot create a Stripe test session, and a demonstration invoice falls back to local checkout when only live credentials are configured. [Checkout reference](https://docs.stripe.com/api/checkout/sessions/create)
- Stripe settlement verifies the raw-body signature, time window, registered session, amount, currency, metadata and mode before recording payment. Replayed callbacks cannot duplicate revenue. [Webhook guidance](https://docs.stripe.com/webhooks/signature)
- Operator routes reject unauthenticated requests and cross-origin cookie writes. Customer routes reject a wrong workspace token. Private GET responses are not cached.
- Signed inbound inquiry retries deduplicate, including concurrent delivery. Unsigned, altered and conflicting provider events are rejected.

The targeted commerce suite passed **13 of 13 tests** after these additions. The final application build and suite should be rerun whenever provider or workflow code changes.

## Activation and limits

`npm run doctor` confirmed the database schema, operator configuration, seven Naïve agent roles, native execution tools, live Naïve account/model readiness and optional ROS image. External email, Stripe and the optional inbound gateway were reported as pending activation. No credential values were printed.

Support requests cap each model-call allowance to the lesser of $0.50 and the job's remaining recorded spending allowance. This is a per-call check, not a global atomic reservation system across concurrent engineering and support sessions.

Maintenance currently checks delivery integrity and raises bounded change requests. It does not automatically charge recurring subscriptions, monitor production behavior, scan upstream dependency releases or perform an unapproved upgrade.
