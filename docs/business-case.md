# Business case

> **Updated 2026-11-04.** Goose is now positioned as an AI team that plans and delivers upgrades, not one fixed conversion. It inspects first and chooses among recipes: Django LTS in place, Flask in place, or the FastAPI + PostgreSQL replacement. Current capabilities and limits are in `docs/scope.md`. Figures below that describe the first version are kept as they were; they come from runs on synthetic sample applications, whose run records are not kept in this repository.

## The business in one paragraph
Goose sells a finished, proven upgrade of an old application - not a tool. A customer sends code and a copy of
the database; agents assess it, quote a fixed price, record the old app's behaviour, freeze the checks, upgrade the
code, move the data, verify on separate copies, repair within a budget, deliver with a report and a rollback guide,
invoice after acceptance and follow up. The first product is one upgrade (Flask + SQLite to FastAPI + PostgreSQL).
The long-term opportunity is larger estates, reached through software-service partners.

## Competitors (primary sources, `docs/research/competitors.md`)
| Option | What the buyer gets | Gap for our buyer |
| --- | --- | --- |
| AWS Transform | Agents you operate; Python version upgrades; custom transformations at $0.035 per agent-minute | Flask to FastAPI not named; no SQLite data move; you run it |
| GitHub Copilot modernization | IDE/CLI upgrade tooling; per-seat Copilot plans | Python support limited to one agent-framework migration; no data move |
| Moderne / OpenRewrite | Recipe-based refactoring at estate scale; published typical prices of $250K-$5M | No Flask-to-FastAPI migration recipe; enterprise-sized |
| Devin, Factory | Agent platforms you operate, $20-$200 per month tiers | Someone must drive them and own the result; no fixed price or evidence package |
| Mechanical Orchard | Mainframe rewrites, verified against production behaviour, billed on proven equivalence | Mainframe only; enterprise; closest in spirit |
| pgloader | Free SQLite-to-PostgreSQL data loader | Data only, no code, no behaviour checks |
| Coding agents (Claude Code, Codex, Cursor) | Any stack, developer-driven, $0-$500 per month | The developer is the verification |
| Agencies and freelancers | Done for you, usually quoted per job | Price and evidence vary; Python modernization rarely packaged |

**Why a customer would choose Goose:** they want the job finished and proven, not a tool; they have no developer
to drive an agent; they need a fixed price; and they want evidence that does not come from the code's author -
checks frozen before any change, every row compared, and a rollback guide. Competitors are stronger on breadth,
scale, brand, enterprise trust, and - for a buyer who has a developer - price.

## Plain answers

**Why hire us instead of an existing coding agent?** A coding agent writes code for a person who then has to check
it. We sell the checked result: the customer gets a fixed price and a report of what was tested, and pays after the
checks pass. If the customer has a capable developer with time, a coding agent plus pgloader is cheaper.

**Why trust us with the application and data?** We work on copies (uploads stored read-only, the original never
modified); customer code runs sandboxed without internet or access to other jobs, with its own database login; the
checks are hashed and frozen before work starts; every decision and intervention is on the record; delivery needs the
customer's acceptance. We hold no certifications and do not claim any.

**What can we complete reliably today?** Flask (1.x/2.x) JSON APIs on SQLite with hand-written SQL, inside the size
limits in `docs/scope.md`. Evidence from earlier runs on two synthetic sample applications: the main one passed 173 of 173 checks; the
second, written afterwards, passed 108 of 109 after the playbook learned from its first runs.

**What do we reject or escalate?** Rejected before any price: other frameworks, ORMs, other databases, templates,
sessions and logins, uploads, background jobs, run-time SQL, oversized apps. Escalated to the founder: data decisions
the customer cannot make, failures the repair playbook cannot explain, a used-up repair budget, failed integrity of the
frozen checks, a spending limit about to be passed. Each escalation is a recorded intervention.

**What improves as we complete more jobs?** The playbook (analyzer, codemod, scenario, checks). The second
application added five general patterns (app factories, per-app runtimes, env-var database paths, UTC timestamps,
HTTP-date output) and exposed a verification gap that is now a blocking check. Each failure we see once is a rule.

**Can revenue grow without founder effort growing at the same rate?** That is the goal and the thing to measure, not a
result yet. The system records founder minutes per job. Routine work (assessment, proposal, upgrade, checks, package,
invoice draft, follow-up drafts) ran with no founder action in every test job without a test fault; founder
time went to test faults, test payments, one limit raise and one rebuild after a playbook fix.

## Which advantages the prototype actually demonstrates
- **Strong verification** - demonstrated: frozen hashed checks, every-row comparison, old-versus-new replay, a
  coverage gate, four kinds of injected fault caught and repaired, one real gap found and closed.
- **Reusable migration knowledge** - partly: the playbook generalised to a second app after fixes; two apps is a small sample.
- **Repeated experience with one app type** - not yet (no real jobs).
- **Distribution through partners** - not yet (agencies identified, none contacted).

## Commercial operations (implemented)
Prospects with public evidence and fit (`/ops/company`), outreach drafts that are never sent automatically, fit
assessment, fixed-price proposals with acceptance, delivery tracking, customer questions answered by the commercial
agent (or passed to the founder), invoices (test invoices labelled), test payments kept apart from collected revenue,
follow-up drafts, cost per job including failed attempts, and founder interventions with minutes.

For a real customer the system records: how they were acquired (`accounts.acquired_via`), what they agreed to buy
(accepted proposal and its scope hash), what was delivered (package hash), whether they accepted (approval), money
collected (payments marked real), direct costs (cost entries), founder time and interventions.

## Customer acquisition plan (next two weeks)
1. The engine has already assessed the two strongest prospects' public code: both are **outside v1** (Flask-SQLAlchemy,
   templates). So: look for prospects with hand-written-SQL JSON APIs
   for the first pilot, and build the Flask-SQLAlchemy + templates recipe next.
2. Send the founder-approved outreach drafts, starting with organisations that pin Flask 1.x and have open upgrade PRs.
   Offer a free written assessment; the pilot price is only discussed when the app fits.
3. Ask two agencies that publish Flask work whether they have one client app we can upgrade under their name.
4. Add the next recipe the replies ask for (most likely Flask-SQLAlchemy), using the same frozen-check machinery.
5. Measure: replies, assessments sent, fits, proposals, acceptances, founder minutes per job, cost per job.

## Unit economics (what we know)
- Price (experiment): $1,500 per pilot. Internal spending limit: $25 per job.
- Measured direct compute per job in local mode: 15-30 seconds, about $0.0003-$0.0006 at Naive's published computer
  rate. Not measured: model cost on Naive, founder time on real jobs, sales effort. No revenue yet.
