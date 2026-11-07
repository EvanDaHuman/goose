# Connecting the live agent team (Naive)

**Status on 2026-11-04:** not connected. `.env` has no `VETTA_API_KEY` and `GOOSE_MODE=local`, so every run so far used
Goose's deterministic tools and no AI model was called. Everything below is checked against Naive's quickstart as published
today (https://vetta.sh/docs/quickstart.md) and the public API description (`https://api.vetta.sh/v1/openapi.json`, version
2026-09-30, unchanged for the endpoints Goose uses). The SDK `@usenaive-sdk/vetta` 0.10.0 is still the latest release.

These steps involve your account and a payment, so they are yours to do. Do not paste the key into a chat or a ticket.

1. **Install Naive's CLI** (or prefix each command with `npx @usenaive-sdk/vetta-cli`):
   ```bash
   npm i -g @usenaive-sdk/vetta-cli
   ```
2. **Sign in and check which organization you are in** before spending anything:
   ```bash
   vetta login --email you@example.com
   ```
   ```bash
   vetta whoami
   ```
3. **Start a plan.** Nothing outside billing answers until the organization has one. Standard is $20 a month with $20 of credit and a
   7-day trial (card required). `subscribe` prints a hosted checkout link; complete it in your browser.
   ```bash
   vetta plan subscribe
   ```
   ```bash
   vetta plan show
   ```
4. **Optional: add credit** (another hosted checkout).
   ```bash
   vetta credits topup --usd 50
   ```
5. **Create a key with exactly these scopes.** The secret is shown once.
   ```bash
   vetta keys create --name goose --scopes agents:write,agents:read,sessions:write,sessions:read,files:write,files:read,billing:read
   ```
6. **Put it in `.env` with an editor**, not on the command line (keeps it out of your shell history), and switch the mode:
   ```
   VETTA_API_KEY=sk_...
   GOOSE_MODE=naive
   ```
   Keep the file private: `chmod 600 .env`. Restart Goose (`npm start`) so the worker reads it.
7. **Run the smoke test.** It checks the plan, the scopes and the model, provisions the four agents, runs one real session and
   writes the result to `docs/evidence/naive-smoke.md`. A wrong key or a missing scope stops it with the exact reason.
   ```bash
   npm run naive:smoke
   ```

## What runs live once it is connected
- **Assessment agent** writes the plan from the repository it fetches into its own computer; the same guard as today checks it.
- **Implementation agent** makes the changes no deterministic tool can make (bug fixes, APIs with no mechanical rewrite), and
  repairs from failure evidence. A job that stopped in local mode at "needs the live agent team" can be continued once the key is in:
  `npm run founder -- retry JOB "live agents connected"`. The verifier's check for the change is frozen before the agent starts and is
  never sent to it.
- **Verification agent** explains failed checks; the checks themselves stay deterministic and frozen, out of the agents' reach.
- **Coordinator** answers customer messages and decides between repair and escalation within the repair budget.
- **Growth agents** (`npm run growth`, or the worker's schedule): the research agent finds prospects from public sources (web search
  and fetch), the qualification agent scores them against today's recipes (web fetch), and the outreach agent writes drafts (no tools).
  They never see customer code and nothing they write is sent. Their sessions belong to no job (`job_id` is empty in `naive_sessions`
  and `cost_entries`) and count against the growth daily limit (settings `growth.daily_limit_usd`, default $2).

Spending limits are set per agent: monthly budgets of $40 (coordinator), $60 (assessment), $100 (implementation), $40
(verification), $20 (research), $15 (qualification), $10 (outreach), and a ceiling per task of $2, $3, $8, $2, $1, $0.50 and $0.25. For a small balance, `NAIVE_CAP_USD` and `NAIVE_TASK_USD` in `.env` lower
every agent's monthly budget and per-task ceiling to at most those values. Every session's metered cost (`consumed_micro_usd`) is recorded with the
job, including failed and retried sessions.

## What has been verified, and what has not
The four agents are provisioned on Naive and a live coordinator session has completed with structured output
(`docs/evidence/naive-smoke.md`). The rest of the integration is checked by contract tests against the real SDK and the published API
description (`npm test`), which cannot show that an agent delivers working changes. Treat agent delivery as unverified until a live
job has run and its evidence is recorded.
