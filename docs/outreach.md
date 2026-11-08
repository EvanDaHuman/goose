# Prospect outreach (AgentMail)

The growth pipeline ends in a real email:

1. **Research agent** finds a repository or organisation and records public evidence of what is outdated (pinned versions, open security PRs, end-of-life runtimes).
2. **Qualification agent** names the Goose recipe that would fix it and any blockers.
3. **Outreach agent** drafts the email (or the fixed template in local mode). The draft leads with what is outdated, then what Goose would do.
4. **`lib/outreach.ts`** resolves a published contact, composes the exact message (signer, link to `GOOSE_PUBLIC_URL`, postal address, opt-out line), sends it from the AgentMail inbox and records replies.

## Contacts

Only addresses the organisation publishes for contact are used, in this order: a role address (`hello@`, `info@`, `sales@`, …) on the organisation's own website (from the prospect's contact channel or its GitHub profile's website, checking `/contact`, `/contact-us`, `/about`), then the public email on the owner's GitHub profile. Commit-author addresses are never harvested; no-reply, legal, security and privacy addresses are skipped. Set `GITHUB_TOKEN` to avoid the 60 requests/hour anonymous GitHub limit.

## Sending

- **Per message (default):** `/ops/company` → *Prepare email* → *Send to …*, or `npm run outreach -- send <id> --yes`. The authorization is bound to the SHA-256 of recipient, subject and body.
- **Policy:** *Let the agent send* (or `npm run outreach -- policy on 5 High`) lets the worker send one message at a time, `spacingMinutes` apart (default 10; `policy on 10 Medium 10`), up to the daily cap, to High (or High and Medium) fit prospects **found by the live research agent** (seeded or hand-entered prospects are only sent manually) with a published contact. `OUTREACH_DAILY_MAX` is a hard ceiling for both modes.
- **Test copies:** *Send test copy to me* / `npm run outreach -- test <id>` sends the exact email, subject prefixed `[TEST for <real recipient>]`, to `OUTREACH_TEST_RECIPIENT` only.
- `npm run outreach -- preview <id>` prints the exact email without sending it (once real sending is configured it is kept as the draft that `send` will use).

Real sends are refused until `OUTREACH_SIGNER`, a public https `GOOSE_PUBLIC_URL` and `OUTREACH_POSTAL_ADDRESS` are set. A rejected send is marked failed; a timeout is marked uncertain and must be reconciled in AgentMail. Nothing is retried automatically.

## Replies

The worker polls the AgentMail thread of every sent message every 5 minutes (no public URL needed). If `/api/webhooks/agentmail` is registered, replies are matched to their thread as they arrive. A human reply marks the prospect *replied* and opens a customer inquiry (`source = outreach_reply`). "Unsubscribe", "not interested" and similar replies (read above the quoted text), and bounces, add the address to `outreach_suppressions`; it is never emailed again. Out-of-office replies are ignored.
