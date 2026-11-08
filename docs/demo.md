# Demonstrating the operating company

Use `http://localhost:3100`. Sign into `/ops/login` with the local operator token. Keep credentials and customer tokens off public slides.

## Four-minute route

1. **Customer and result, 40 seconds.** Open completed ROS engagement `GS-1004` and its recorded mission. Show the delivered ROS 2 source and the two repaired runtime failures. Identify the synthetic customer and real Naïve work. Briefly open `GS-1001` to show the same company also completed a Python-to-Node change with a new feature.
2. **Engineering proof, 60 seconds.** Show baseline, frozen contract, 14 passing engagement checks, diff and archive. Explain the separate 111 algorithm checks and nine simulation checks. State the verifier amendment and the repeated-destination limitation. Describe 50 successful Nav2 requests across three logged destinations accurately; do not present them as 50 distinct exploration goals. See [the full evidence](evidence/ros-workflow.md).
3. **Business operations, 60 seconds.** Show `/ops/company` research and drafts, then `/ops/business` inquiry, notifications, invoice, test payment, support and monitoring. Show a requested follow-up becoming a separately scoped engagement.
4. **Autonomy and economics, 40 seconds.** Show actual Naïve sessions, decisions, metered costs, retries and interventions. Identify synthetic approvals and configured providers. Include development fixes.
5. **Expansion, 20 seconds.** One company coordinates different execution adapters. The opportunity is recurring engineering outcomes across customer software estates. Hardware and arbitrary production deployments are outside the demonstrated scope.

## Reproduce

```bash
npm run workspace:demo
```

This uses live Naïve with a $20 job limit. The harness approves only its exact synthetic fixture and labels approvals TEST. Stop the worker while the standalone harness owns a job. Resume with `npm run workspace:demo -- GS-id`. Add `--robotics` to create or resume the pinned ROS engagement.

```bash
npm run workspace:evidence -- GS-id docs/evidence/my-run.json
```

The isolated integration suite injects wrong behavior, evidence/candidate tampering, payment mismatches and repeated webhooks. These are controlled tests, not production incidents.

## Provider activation

Follow [commerce setup](commerce.md). AgentMail needs a key and inbox ID. Stripe needs secret/webhook keys and a reachable webhook endpoint. Live operation needs HTTPS. Invoice and payment-key modes must match. Keys alone cannot supply a public callback address, verified sender or provider account.

Do not initiate prospect outreach or a charge just to make the demo appear active. Real outcomes need authorization and provider evidence. Local test receipts demonstrate the workflow honestly.
