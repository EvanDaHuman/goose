# Live migration evidence, November 7, 2026

Goose used the real Naive SDK and model `zai-org/GLM-5.2-FP8` to assess and rewrite the synthetic customer ledger in `demo/migration-ledger`. The task migrated Flask to Rust, preserved the legacy API and data, added customer tiers with a default, created seeded segments, and exposed new endpoints for reading and changing the added data.

The source contains Unicode, nullable values, non-contiguous identifiers, relationships, integer money and timestamps. The migrated delivery contains the original snapshot plus approved schema changes and seed rows. Verification writes run on separate copies.

## First delivery: GS-1004

- Delivered on attempt 1, with **47/47 mandatory checks passing**, no failed or skipped checks, and no implementation repair.
- Assessment: `ses_3yhqbp3efpeapn9rxkdzmf0sg9`.
- Implementation: `ses_8gak654b64w15jnxfxxxwck4bv`.
- Metered Naive usage: **$0.609370**. Measured local runtime is recorded separately as an estimate.
- The first baseline needed a development correction to allow the resolved uv-managed Python interpreter inside the sandbox. A two-minute founder retry is recorded. The coordinator proposal used the recorded deterministic fallback while local agent provisioning records were being restored.
- Independent verification and packaging were run again after adding candidate integrity binding, schema checks and report display compatibility. That validation is recorded separately; application code and frozen expected results did not change.
- The interactive preview created a new customer with a custom payload and read it back from the actual Rust service. Preview data is disposable and is not part of the delivery snapshot.

The checks cover frozen-artifact integrity, every original value and schema definition, repeatable migration, a later source snapshot, actual Rust compilation, 14 legacy HTTP requests, new-data requests and stored-value assertions, and three reads after process restart. Auto-increment state is checked independently as well.

Export the auditable record from the running checkout:

```sh
npm run migration:evidence -- GS-1004 /absolute/path/rust-migration-first-run.json
```

## Blocked repeat: GS-1008

The second live assessment produced a contradictory collection expectation: `/v2/customers` was expected to list only the three customers created by the checks. The actual service correctly returned those plus the three preserved customers. Independent verification reported **46/47**, blocked delivery, and the coordinator entered repair. Development review stopped that repair before a code change, preserving the frozen contract and failure evidence. A three-minute intervention is recorded. This run is not counted as an autonomous success.

The resulting fix adds explicit collection matching and a contract guard before approval. Tests prove that allowing preserved records still rejects missing new records, duplicate matching and incorrect ordering. Existing frozen expectations were not rewritten to turn this failure into a pass. A new live fixture uses the revised contract rules.

```sh
npm run migration:evidence -- GS-1008 /absolute/path/rust-migration-blocked-run.json
```

## Latest delivery: GS-1013

- Delivered on implementation attempt 1: **40/40 mandatory checks passed**, none failed or skipped. The contract includes 14 legacy requests, nine new-feature requests, two independent stored-value assertions, and two reads after restart, plus integrity, schema, snapshot and runtime checks.
- Assessment: `ses_j2tytdddkttq37febqjyjfn3x2`; coordinator: `ses_d11yhxvsfvp5r4jzr5x6vpfhvg`; implementation: `ses_yhwwk3crrza29t6d81wbf7dpca`.
- Metered Naive cost: **$0.334618**. Local compute estimate at delivery: $0.000574.
- The implementation hit its iteration boundary. A stale idle read caused a second continuation request to receive `409 session_running`. The underlying session remained active. The runner now keys continuations to the observed stop sequence and tolerates that active-session conflict.
- An explicit retry also exposed cached blocked-stage results being treated as completed work. Recovery now resumes the correct stage round/attempt while preserving run counts. Two retry interventions, totalling two recorded minutes, document these development fixes.
- The same implementation session was resumed. No generated application code or frozen expected result was manually changed. This is a delivered live run with recorded development interventions, not a claim of zero human intervention.
- Package SHA-256: `60fcf5ea46e2d26145c830bf91397a4f215c46f2de0d912b2f0b2fc0d9b3c2f8`.

```sh
npm run migration:evidence -- GS-1013 /absolute/path/rust-migration-latest-run.json
```

Final regression results: 25 integration tests, 35 engine tests, 160 sales-workspace tests and four browser flows pass. TypeScript and the production build pass. The added recovery tests reproduce the continuation race and blocked-stage cache failure.

## Relationship to the YC / Naive criteria

The event brief asks for an agent-run company, evidence of what its agents accomplish and decide, and an honest account of human intervention. Its award categories include Most Autonomous, Most Likely Unicorn, Best Use of Naive and People's Choice. See the [Naive event page](https://usenaive.ai/hackathon) and the supplied brief.

| Criterion | Concrete evidence | Remaining limit |
| --- | --- | --- |
| Autonomous delivery | Durable intake, assessment, proposal, baseline, frozen checks, agent implementation, independent verdict and packaged delivery; budgeted repair and restart handling | Real customers still approve scope and delivery; production traffic is not switched automatically |
| Use of Naive | Real SDK sessions, agent identities, structured results, uploaded source, published implementation archives and metered usage | Deterministic inspection, migration and verification are explicitly labelled tools |
| Find and serve customers | Existing live research, qualification and outreach-draft cycles, plus an executable delivery workflow | Prospects have not been contacted; no real customer, payment or product-market-fit claim |
| Decisions and interventions | Job events, session history, stage attempts, cost entries, approvals and founder interventions exported together | The first development run required the intervention listed above |
| Product demonstration | Customer upload flow, reviewable contract, exact comparisons, downloadable app and database, interactive backend preview | A bounded synthetic migration demonstrates capability, not every application's correctness |

These are evidence mappings, not a claim that judging outcomes or commercial criteria have been met.

## Boundaries

Rust, Node.js and Python target adapters currently operate on executable JSON services backed by SQLite snapshots. Existing framework and PostgreSQL recipes remain separate. Other targets need an implemented and tested adapter. Invalid contracts and unsupported requests stop before implementation.

The cutover tool can rebuild from a newer source snapshot. It does not provide continuous replication, merge target-side writes, guarantee zero downtime, or perform an automatic lossless reverse migration. Production load, external integrations and unrecorded behaviours remain outside this proof.

Python and Node adapter tests also exercise successful writes and restart persistence. Deliberately corrupted writes, altered frozen evidence and changed post-verification source all block delivery. These deterministic tests are not represented as agent-generated implementations.
