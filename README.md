# Goose

**An autonomous engineering company that takes responsibility for changing existing software.**

Give Goose a system, a business objective and a budget. Its Naïve team assesses the work, agrees an executable scope with the customer, implements the change, verifies it against the original, repairs failures within budget and delivers the result with evidence. Customer operations cover inquiries, proposals, acceptance, invoicing, payments, support and continuing integrity monitoring.

The company is broad. Robotics is one demanding demonstration, alongside service and database migrations and general repository engineering. Every job needs an execution environment and a contract Goose can actually run. Unsupported requirements stop at assessment.

Built for the [Naïve Autonomous Companies Hackathon](https://events.ycombinator.com/naive-autonomous-companies-hackathon). This independent repository starts from the Portwright migration foundation and adds a general engineering engine and the business workflow around it.

## What runs

| Capability | Implementation |
| --- | --- |
| Acquisition | Scheduled Naïve research, qualification and outreach drafts with public evidence and spending limits |
| Intake and scoping | Inquiry form, source uploads, live assessment, executable contract, fixed-price proposal and customer approval |
| General engineering | Agent-written repository changes with separate builds and preserved/new behavior checks |
| Code and data migration | Service adapters for Python, Node and Rust; data continuity, new writes, restart and migration idempotency checks |
| Robotics | Pinned ROS 1 exploration source, ROS 2 Jazzy build adapter and independent Gazebo/Nav2 harness; see `robotics/` |
| Delivery | Frozen expectations, independent checks, bounded repairs, candidate hashes, source archive, report and runbook |
| Business operations | Acceptance, invoices, Stripe Checkout/webhooks, AgentMail/custom email, support and capped follow-up jobs |
| Continuing care | Scheduled delivery-integrity checks and follow-up change requests |
| Accountability | Metered Naïve cost, labelled compute estimates, session provenance, approvals, founder interventions and job leases |

See [execution scope](docs/scope.md), [commerce setup](docs/commerce.md) and [demo guide](docs/demo.md). Production deployment and broad dependency monitoring are not implemented. A passing contract is evidence for its scope, not proof of all possible behavior.

## Recorded proof

The live routing-engine engagement `GS-1001` migrated Python to Node.js, added blocked-link support and completed proposal, implementation, verification, delivery, acceptance, invoice and follow-up. Naïve performed assessment and coding; tools executed original and candidate separately. The [exported record](docs/evidence/workspace-routing-live.json) contains actual sessions, costs, checks, stage history and a development intervention. Its [unchanged delivery archive](docs/evidence/deliveries/GS-1001.zip) includes the generated source, frozen contract and verification evidence.

All current customers, approvals and payments in the demonstrations are synthetic and labelled accordingly. There is no claimed real revenue. Earlier migration and growth records under `docs/evidence/` belong to the predecessor build and are historical evidence, not new customer outcomes. ROS evidence lives under `robotics/evidence/` and must be checked for its actual verdict.

The live ROS engagement `GS-1004` also completed delivery, acceptance and TEST settlement after two Naïve code repairs. Its final checks passed 14/14, including 111 algorithm checks and nine Gazebo checks. The robot travelled 3.798 metres. Repeated destination requests remain a documented exploration-quality limitation. See the [full workflow evidence and reproducible delivery](docs/evidence/ros-workflow.md).

The [validation record](docs/evidence/build-validation.json) covers 67 integration tests, 35 engine tests, six browser workflows, seven robotics harness tests, production build and readiness checks. Integration and browser suites use disposable databases. Provider calls are mocked; live email and payment activation remains separate.

## Run locally

The native executor targets macOS on Apple Silicon. Install Node 22 or later, Homebrew `python@3.13`, `uv` and `postgresql@17`. The AgentMail signature library requires Node 22 or later. The ROS adapter additionally needs Docker with a running Linux VM and its image built from `robotics/Dockerfile`.

```bash
npm run setup
```

Setup installs dependencies, creates local PostgreSQL and Python environments when needed, applies migrations and generates a private operator key. It preserves an existing `.env` and database configuration. Never commit `.env` or `var/`.

For live agents, configure `VETTA_API_KEY`, set `GOOSE_MODE=naive`, then:

```bash
npm run naive:provision
npm run naive:status
npm start
```

Open [localhost:3100](http://localhost:3100). `/ops/login` accepts `GOOSE_OPERATOR_TOKEN` from local `.env`. Customer workspaces use separate unguessable tokens. Local mode runs deterministic service fixtures and test commerce; general engineering requires live Naïve.

Add AgentMail and Stripe keys when ready. Their absence does not prevent test engagements, local test checkout or recorded test notifications. Real sends and settlement require providers and the relevant authorization. See [commerce setup](docs/commerce.md).

`npm run test:e2e` builds an isolated production app on port 3101, creates a disposable database and job directory, and runs the browser workflow with live agents and external providers disabled. It removes its test data and stops its services afterward. It does not add fixtures to the company's history. Set `GOOSE_E2E_PORT` if port 3101 is occupied.

## Commands

| Command | Purpose |
| --- | --- |
| `npm start` / `npm stop` | Start or stop this checkout's web app and worker |
| `npm run workspace:demo` | Full live Naïve engagement on a synthetic engineering fixture |
| `npm run workspace:demo -- --robotics` | Full company workflow on the pinned ROS migration fixture |
| `npm run workspace:evidence -- GS-id evidence.json` | Export actual engineering history without workspace tokens |
| `npm run migration:demo` | Live service/data migration demonstration |
| `npm run growth` | Bounded research, qualification and drafts |
| `npm run founder -- note GS-id "reason"` | Record an intervention; CLI also supports recovery actions |
| `npm run typecheck` / `npm run build` | Type checks and production web build |
| `npm test` / `npm run test:engine` | Isolated integration database and Python tests |
| `npm run test:e2e` | Browser workflow against a local-mode app and worker |

Pages: `/contact`, `/start`, `/jobs/<id>?t=<token>`, `/ops`, `/ops/company`, `/ops/business`, `/ops/naive`.

## Execution model

PostgreSQL leases coordinate workers and durable stages. Source behavior runs twice before quotation and again before expectations are frozen. Customer approval freezes scope. Implementation receives source and public interfaces, without recorded expected outputs. Separate execution decides acceptance. Delivery binds the archive to the exact verified files and unchanged evidence.

Naïve agents use isolated company identities, typed outputs, budgets and idempotent sessions. Candidate code receives a scrubbed environment and executes on copies under macOS sandbox profiles or capped Docker containers. Operator sessions are authenticated; cookie mutations require the same origin. Signed provider webhooks are idempotent. Test payments are excluded from real revenue.

This is a working local prototype, not a production multi-tenant hosting service. See [scope](docs/scope.md) for the trust boundary.

## Layout and attribution

`app/` and `components/` contain UI and APIs. `lib/` and `worker/` contain the company engine, Naïve team and commerce. `engine/` contains service/data executors. `robotics/` contains pinned source, the container adapter and independent harness. `db/migrations/`, `scripts/` and `tests/` provide setup and validation.

The migration foundation comes from `adhvaidhsunny/portwright`, `goose-rebrand`. Pinned `rrt_exploration` source retains its MIT license and revision manifest. ROS, Nav2, Gazebo and SLAM infrastructure are reused with attribution. The legacy SuiteCRM test fixture retains its AGPL attribution. Goose does not claim authorship of these projects.


### Readiness and commercial workflow

Run `npm run doctor` to check the local database, current schema, operator access, Naïve readiness, supported execution tools and provider activation without printing credentials. `npm run commerce:status` reports configuration presence only. Email and payment keys can be added later; their missing state is explicit and local TEST flows remain available.

After a synthetic engineering job has completed with a TEST invoice, `npm run commerce:demo -- GS-1001` exercises its local commercial lifecycle while preserving the verified delivery. It records no real payment, sends no external email and starts no follow-up engineering job. See [commerce setup](docs/commerce.md) and [recorded commercial evidence](docs/evidence/commerce-live.md).
