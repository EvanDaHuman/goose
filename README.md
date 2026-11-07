# Goose

**Give us your existing software and tell us what needs to change. Our AI team plans and delivers the upgrade, including the code,
data, and checks needed before you switch.**

Goose inspects the application it is sent, proposes the smallest change that meets the owner's goal, freezes the checks the
result must pass, builds and moves data on copies, verifies independently against how the original behaved, and delivers with
evidence, a switch-over plan and a rollback guide. The customer pays a fixed price only after the checks pass.

Built for the Naive Autonomous Company Hackathon (YC, November 7-8, 2026).

> **Status, plainly.** All seven agents are provisioned on Naive. Live agents have delivered two synthetic Flask-to-Rust migrations
> with requested schema additions, preserved history and new writes, passing 47 and 40 independent checks. Development fixes
> and retries are recorded, along with a blocked run. See [the live migration evidence](docs/evidence/migrations-live.md) for sessions,
> costs, interventions and coverage limits, and [growth results](docs/evidence/growth-live-runs.md) for prospect research.
> There are **no real customers or paid deployments yet**: demonstration approvals and invoices are labelled TEST.

## What Goose can carry out today

| Recipe | When it applies | What changes | How it is verified |
| --- | --- | --- | --- |
| Django 5.2 LTS in place | Django below 5.2 | Django 5.2 + Python 3.13, removed APIs rewritten, settings whose defaults changed kept | Same requests to old and new app on separate copies, every row afterwards, the app's own tests, outside scripts re-run |
| Flask current, in place | Flask apps | Current Flask libraries + Python 3.13, mechanical rewrites of removed imports | Same requests to old and new app, every row afterwards, the app's own tests |
| Replace with FastAPI + PostgreSQL | Flask + `sqlite3` JSON APIs, with a copy of the data | Codemod that keeps the owner's SQL, PostgreSQL schema, re-runnable data move | Every row and field, money, stock, retries, concurrency, dates, old-versus-new answers |
| SuiteCRM 7 → sales workspace | SuiteCRM 7.11.23 with a database dump | The sales workflow moves to a FastAPI + PostgreSQL workspace configured from the inspection; support and the rest stay in SuiteCRM | Every record, relationship and custom field; each user's access compared with the original; the custom approval rule replayed against the original |
| Targeted changes by the agent | Changes no tool can make (bug fixes, APIs with no mechanical rewrite) | The implementation agent on Naive edits the code | The same frozen checks, which the agent never sees |
| Target-driven language migration | Executable Flask/Python/Node JSON services with SQLite snapshots | Naive agents build Rust, Node.js or Python services; approved fields, tables and seed records are migrated transactionally | Frozen API replay, independent cell/schema/constraint comparison, new writes, process restart, repeated migration and a fresh source snapshot |

Anything else is inspected and reported on, but not quoted. Limits are in `docs/scope.md`.

See [target-driven migrations](docs/migrations.md) for runtime limits, data contracts, the live Rust proof, preview and cutover instructions.

## How Goose finds its own work

A growth cycle runs on a schedule in the worker (every 24 hours by default), from `/ops/company`, or with `npm run growth`:

1. **Research agent** (`goose-research`): finds organisations whose public code or announcements show outdated software Goose can
   upgrade, with a public URL for every claim. Web search and fetch only; it never sees customer code.
2. **Lead qualification agent** (`goose-qualification`): scores each prospect High, Medium or Low against today's recipes, reading
   its public requirements or settings files, and names the recipe that would apply.
3. **Outreach agent** (`goose-outreach`): writes a specific, honest first message for each High or Medium prospect.

Every result passes a guard before it enters the pipeline (`lib/growthRules.ts`): no personal e-mail addresses or phone numbers, a
public https source for every claim, no duplicates, only real recipes, and no invented prices, customers or results in a draft. A
rejected or failed agent result falls back to local rules, and both are recorded. The cycle has its own daily spending limit
(settings `growth.daily_limit_usd`, default $2). **Nothing is sent**: drafts wait in `/ops/company`, because no e-mail provider is
connected.

## Quick start (macOS, Apple silicon)

Needs Node 20.9+, Homebrew `python@3.13`, `uv` and `postgresql@17`. SuiteCRM jobs also need `colima`, `docker`, `docker-compose` and
`docker-buildx` (`brew install colima docker docker-compose docker-buildx`), because the customer's original application runs in a
container in a local Linux VM.

```bash
npm run setup
```
```bash
npm start
```
Then open http://localhost:3000/start, describe the goal and upload the application (a `.zip`, optionally a SQLite file or MySQL dump).

To run the agents live, put a Naive key in `.env` and set `GOOSE_MODE=naive` (`docs/naive-setup.md`), then:
```bash
npm run naive:provision
```
```bash
npm run naive:smoke
```

| Command | What it does |
| --- | --- |
| `npm start` / `npm stop` | The web UI (http://localhost:3000) and the worker |
| `npm run naive:status` / `naive:provision` / `naive:smoke` | Naive readiness; create or update the seven agents; one live session |
| `GOOSE_MODE=naive npm run migration:demo` | Bounded live Rust migration of a synthetic ledger, with recorded test approvals |
| `npm run migration:evidence -- JOB FILE` | Export actual sessions, checks, costs, approvals and interventions |
| `npm run growth` | One growth cycle now: research, qualification, outreach drafts (nothing is sent) |
| `npm run founder -- retry\|replan\|rebuild\|limit\|note JOB ...` | Founder actions, each recorded as an intervention |
| `npm run crm -- serve JOB [port]` | Run a delivered SuiteCRM sales workspace on its moved data (http://localhost:8090) |
| `npm run crm -- cutover JOB FINAL.sql.gz` | Switch-over: move the customer's final dump (taken after they pause sales edits) and re-run the data checks |
| `npm run crm -- remigrate JOB` | After a rehearsal: put the workspace's data back to what the move produced |
| `npm run crm:evidence -- JOB` | Write a SuiteCRM job's evidence record from its database rows and files |
| `npm run history -- FILE` | Export every job's outcome, including failed attempts and founder time |
| `npm test` / `npm run test:engine` / `npm run test:e2e` | Naive contract tests / engine tests / browser tests |
| `var/venvs/sales-workspace-dev/bin/python -m pytest engine/targets/sales_workspace/tests` | The sales-workspace template's own tests |

Pages: `/` what we do · `/start` start a job · `/jobs/<id>?t=<token>` the customer's workspace · `/ops` operator ·
`/ops/jobs/<id>` where each step came from, costs, approvals and interventions · `/ops/company` prospects · `/ops/naive` the agent team.

## How it works

```
customer goal + application (+ database dump, documents)
  -> intake    validate uploads; restore a MySQL dump only into Goose's own workbench database (never the live system)
  -> inspect   map of the application, findings tied to files, lines and database queries; customizations found by difference
  -> plan      options against the goal and constraints; questions only when an answer changes the plan; a new answer re-plans
  -> quote     fixed price; the customer accepts
  -> record    the original's behaviour on a disposable copy
  -> freeze    expected values from the snapshot and the recording, hashed and read-only; the implementation side never sees them
  -> build     deterministic tools, a configured template, or the implementation agent (live mode); data moved in one transaction
  -> verify    the frozen checks against the delivered backend and database, on a disposable verification copy
  -> repair or escalate within the repair budget  ->  package, switch-over plan, rollback guide  ->  invoice  ->  follow-up
```

- **The delivery agents** (`lib/naive/team.ts`, `lib/agents.ts`): the assessment agent writes the plan, the implementation agent makes
  the code changes, the verification agent explains failed checks, and the coordinator decides repair or escalate, words proposals and
  answers customers. Every agent result passes a deterministic guard; no agent can pass a failed check or see the frozen checks.
- **The growth agents** (`lib/growth.ts`, `lib/growthRules.ts`): research, qualification and outreach, described above.
- **Provenance:** every event and file says whether it came from an agent (with its Naive session id), a deterministic tool or a person.
  Customer approvals and founder interventions are recorded separately, with founder minutes.
- **Costs:** every step's compute time is recorded and priced at Naive's published computer rate; Naive sessions record their metered
  cost; each job has a spending limit checked before every step. Failed attempts and retries are included.
- **Isolation:** customer code runs in containers in a local Linux VM (SuiteCRM) or under macOS `sandbox-exec` (Python apps), on copies.

## Repository layout

| Path | What it is |
| --- | --- |
| `app/`, `components/` | The website: start form, customer workspace, operator pages |
| `lib/`, `worker/` | The job engine (a crash-safe stage machine on PostgreSQL), the stages, the Naive agents, the growth cycle |
| `engine/goose_engine/` | Inspect, plan, build and migrate (Python) |
| `engine/goose_verify/` | Record the original, freeze the checks, verify the result (Python) |
| `engine/targets/sales_workspace/` | The sales-workspace template delivered by the SuiteCRM recipe |
| `engine/data/`, `engine/runtimes/` | Version reference data; runtimes for customers' original applications |
| `engine/tests/fixtures/` | Small synthetic sample applications and data used by the tests |
| `db/migrations/`, `scripts/` | Goose's own database schema; setup and operations |
| `docs/` | Scope, Naive setup, business case, research (competitors, prospects: nobody has been contacted) |

## Licences and attribution
SuiteCRM is © SalesAgility Ltd and contributors, licensed under the GNU AGPL v3. Goose never ships SuiteCRM code: the delivered
workspace receives only data and configuration values. The SuiteCRM approval-rule hook in `engine/tests/fixtures/suitecrm-hook/` is a
test fixture written for this project, licensed like SuiteCRM (AGPL v3).
