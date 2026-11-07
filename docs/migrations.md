# Target-driven migrations

Choose a target on `/start`, describe the desired data changes, and upload source plus a SQLite copy. Goose's live assessment agent reads the source and proposes an executable contract. The customer approves the runtime change, exact schema operations, price and checks. The implementation agent then writes the replacement service. The independent verifier owns the verdict, and failed checks enter the existing budgeted repair loop.

The new path is `agent-replatform`. It is separate from the existing Django, Flask, FastAPI/PostgreSQL and SuiteCRM recipes.

## Executable scope

- Targets: Rust, Node.js and Python. Rust builds with Cargo using pinned `tiny_http`, `rusqlite` and `serde_json`; Node uses built-in modules, including `node:sqlite`; Python uses the standard library. Frameworks or dependencies beyond these runtime environments need an adapter extension.
- Sources: Flask JSON services and Python/Node HTTP entry points with an explicit database environment variable. Direct entry points must accept `PORT`. The source must run and produce repeatable baseline responses before implementation begins.
- Data: SQLite snapshots. Add fields with defaults/backfills, rename fields, create tables with primary/unique/foreign-key constraints, and insert explicitly approved seed rows. Destructive changes and arbitrary SQL are rejected. Existing PostgreSQL migration recipes remain available separately.
- Contracts: route coverage, exact legacy status/JSON responses, successful writes, new-feature expectations, independent stored-value assertions, and reads after process restart. Unimplemented requested capabilities block acceptance. A contract can be suggested in `goose-migration.json` inside the repository; the assessment agent still reviews it.

Legacy API responses always match exactly. New-feature object expectations check the specified fields. Arrays also match exactly unless the approved expectation explicitly sets `array_match: "contains"`, which checks distinct expected records in order while allowing existing records before, between or after them. Collection expectations containing saved new identifiers must use this explicit mode or individual record reads. This prevents a test from incorrectly demanding that preserved records disappear from a list. Repair prompts contain structural diagnostics rather than original database values.

Unsupported runtimes are blocked with a capability explanation. A request to migrate to Rust cannot silently select the old Flask upgrade recipe. A rewrite conflicting with `keep_framework`, or outside integrations without executable checks, also blocks before implementation.

## Data continuity and delivery gates

1. Run the original twice on separate copies and compare its responses and final rows. Nondeterministic baselines block the job.
2. Freeze the accepted contract, original snapshot, original responses and post-request data. Anchor their manifest hash in the company database.
3. Apply approved changes transactionally to a new file. The original is opened read-only. Publishing refuses an existing destination. An id plus content hash makes repeated application a no-op and rejects changed operations reusing an id.
4. Independently project the expected rows in the verifier. It imports no migration-engine functions. Compare every cell, column/default, primary key, unique constraint and foreign-key definition. Check SQLite integrity and foreign-key violations.
5. Compile and launch the actual target in a job sandbox. Replay the old requests, compare full JSON values and status codes, and compare the resulting rows with the original's post-request rows.
6. Exercise new writes, invalid writes and requested features. Inspect the stored data, check that old rows and schema survive, restart the process and read the new records again.
7. Rebuild from the source's later snapshot containing baseline writes and verify it independently. This exercises inclusion of data added after the first snapshot.
8. Permit packaging only after every mandatory phase passes. Bind packaging to the exact verified source tree and migrated file. A changed candidate must be verified again.

SQLite integers larger than JavaScript's safe integer range remain exact in database evidence. HTTP APIs returning such numbers as JSON numbers are blocked until a precise representation is agreed, rather than silently rounding them.

## Run the live Rust proof

On Apple silicon macOS, install Rust/Cargo with Homebrew in addition to the normal Goose prerequisites. Node targets need an installed Node runtime with built-in `node:sqlite` available without a feature flag; the adapter was tested on Node 23.11.0.

```sh
npm run naive:provision
GOOSE_MODE=naive npm run migration:demo
```

This uses a clearly synthetic customer ledger. The real Naive assessment and implementation agents receive source code. The harness records a synthetic proposal approval, caps the job at $25 and permits two repairs. It does not accept a real customer's proposal, send outreach, charge money or switch production traffic.

Resume an interrupted job with `GOOSE_MODE=naive npm run migration:demo -- GS-1234`. The script reserves only that job. Workers claim jobs matching their configured execution mode, and Naive sessions retain their existing idempotency keys on retries. A waiting-founder job still needs an explicit recorded retry after its blocker is fixed.

```sh
npm run migration:evidence -- GS-1234 /absolute/path/to/evidence.json
```

The evidence export distinguishes model sessions, deterministic stages, synthetic approvals, metered spending, estimated local compute and founder interventions. It includes failed attempts. This supports the hackathon's request to show what agents actually delivered and where people intervened.

## Try and cut over

A passing delivery includes the actual application, a migrated snapshot without verification test writes, the migration utility, the approved contract, a runbook, code changes and verification evidence. Start its disposable preview from the customer workspace. The request panel sends calls to the delivered backend, saves returned identifiers and supports edited payloads.

At cutover, pause source writes and obtain the latest consistent source snapshot. Run the included `migrate.py` against that snapshot into a **new** output file, reverify the final copy, and switch traffic after approval. This is a snapshot rebuild, not ongoing replication. It does not merge writes already made to a target. Before target writes, the original remains available for rollback. After target writes, preserve and reconcile those writes before restoring the original. Automatic lossless reverse migration is not implemented.

Passing a bounded contract does not establish correctness of unrecorded behaviours, production load, external integrations or zero-downtime operation. Original tests retained in an agent's archive are reference material for the rewrite; the independent delivery checks are the frozen HTTP/data contract. Existing in-place recipes still run their original test suites.

## Extending a runtime

Add a runtime to `migrationContract.ts`, define a scrubbed build/start adapter in `replatform.ts`, and supply source/target lifecycle tests in `migration-runtime.test.ts`. Build dependencies must be prepared separately from customer code, and candidate execution stays sandboxed. Prove successful writes and persistence plus a negative control before advertising a new target. Never add a target name only to the intake dropdown.

`npm test` creates a disposable PostgreSQL database and a separate job-files directory. It never reuses the provisioned company's registry or delivery artifacts.

The browser regression suite tests deterministic local mode. Run it against a web server and worker started with `GOOSE_MODE=local`, then restore live mode for customer migrations. The live demonstration command independently requires `GOOSE_MODE=naive` and uses real metered sessions.
