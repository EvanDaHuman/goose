# Autonomous repository engineering

New repository-engineering requests use Naïve to discover their environment and acceptance tests. Customers can paste a public GitHub link, connect a configured GitHub App for selected private repositories, or upload a ZIP. GitHub intake records the immutable commit. Public intake can use credential-free Git discovery and direct commit archives when the shared REST quota is exhausted. Private access still requires the configured GitHub App. No repository-specific Goose adapter or configuration file is required.

The company workflow still scopes work, requests customer approval, implements, verifies, repairs within budget, delivers and invoices. Existing engagements retain their original executors and frozen evidence.

## What discovery does

1. Naïve reads the upstream manifests, lockfiles, CI, source and tests.
2. It proposes a tagged official Linux runtime image, dependency hosts, setup script, optional service startup script, substantive existing tests and new requirement checks.
3. A generic runner attempts that environment. Failures return to Naïve for up to eight bounded discovery attempts, within the job spending cap, with every attempt retained. An explicitly requested new planning round carries forward completed execution and review findings only when the source and plan hashes still match; it must still pass fresh execution and review.
4. Existing behavior must pass. New-feature checks must fail on the original implementation. A deliberately introduced semantic fault must be detected by a preservation check.
5. A separate Naïve verification agent reviews the test coverage and actual execution evidence. Accepted environments are rebuilt on a fresh instance before a proposal is offered.
6. After approval the original baseline runs again. The environment, acceptance scripts, protected original tests, input hashes and runner version are frozen before implementation.
7. Naïve implements the objective. Each independent check gets a fresh prepared copy, and final verification rebuilds from source. If the implementer reports unfinished work or unavailable local tests, those statements remain visible. Passing host checks alone cannot dismiss them: a separate verification agent must inspect the candidate and resolve every statement against actual execution and the accepted scope. Delivery requires the exact verified candidate, resolved completion findings and unchanged frozen evidence.

Supporting documents and customer clarification answers are included in discovery, independent review and implementation. Accepted requirements are frozen alongside the checks. When a customer selects the no-data-sharing constraint, execution output is withheld from agent feedback because test logs can contain record values. This can reduce automatic diagnosis and require a customer clarification.

Discovery asks a customer question when required behavior or infrastructure is missing. It does not invent credentials, access or business requirements.

Before a repair, the independent verification role inspects the failed check definitions and candidate to explain the actual mismatch, including misleading diagnostic text. The implementation role receives concise guidance and failed results; the full acceptance scripts stay with the verifier. Repairs preserve the frozen contract and remain bounded by the job's repair and spending limits.

## Execution and isolation

The generic backend uses Docker Linux containers on the operator's execution host. It supports official Ubuntu, Debian, Python, Node, Go, Rust, Java, Ruby, PHP and .NET base-image families; agents can install additional tooling inside the environment. The image ID is pinned after successful discovery. Installing an unfamiliar dependency does not require adding a custom migration adapter.

Source enters containers with Docker copy. Candidates receive no host bind mounts, Docker socket, Goose credentials or other customer files. Setup runs with a restricted capability set in an internal network. Only a separate dependency proxy can reach the internet; it permits exact hostnames from the plan, ports 80/443, and publicly routable resolved addresses. DNS results are checked and pinned before connection. Verification runs without external networking, as an unprivileged user, with acceptance scripts mounted read-only. CPU, memory, process, per-command and total execution time are bounded.

Setup and per-check preparation are checked against all input source hashes. They cannot silently rewrite tests or source to make a check pass. Deliberately broken source has its own expected hashes, so preparation cannot undo the negative control. Plans that require changing a protected file are rejected before implementation. Original test and CI files identified in the contract are protected again after implementation. New test files may be added; existing protected files cannot be changed or removed.

Validated uploaded data snapshots are copied into the isolated environment at `/data/input`; the original is never changed. Generated scripts may inspect schema and rehearse transformations on copies. Data does not enter the Naïve workspace through this path. Any failure diagnostics supplied to agents should be considered part of the job's disclosed execution evidence. Synthetic data fixtures can also be created from the repository's own tests.

## Results and limits

Checks can exercise services and databases started locally inside the container. They can validate data transformations, writes, persistence and repeat migration when the discovered contract includes those operations. A passing result applies to the tested objective and captured source, not every behavior of the upstream project.

The backend currently provides Linux containers. macOS-only builds, Windows-only tools, unavailable proprietary services, GPUs and physical hardware require additional execution infrastructure or an explicit customer answer. Large mono-repositories, Git LFS and submodules can need separately supplied source. Package versions without an upstream lockfile remain dependent on registries; the report records the setup and pinned base image, not a promise of bit-for-bit reproducibility of arbitrary external packages.

Generated tests and independent agent review reduce errors but cannot prove completeness. Skipped or excluded upstream checks must remain visible in the plan and evidence. Production cutover, production monitoring, subscription billing and enterprise tenant-isolation certification are not implied.

## Run and inspect

```sh
npm run db:migrate
npm run doctor
npm run naive:status
node --import tsx --env-file=.env scripts/autonomous-demo.ts docs/validation/werkzeug-request.json
```

The demonstration harness downloads the real upstream repository and uses live Naïve, with a $25 job cap. It records synthetic customer approval and acceptance only. Stop the ordinary worker while a standalone harness owns an engagement. Resume with its `GS-id`. Requests under `docs/validation/` contain only the upstream link, revision and customer objective, never a custom environment or test adapter.

The customer workspace shows the discovered runtime, coverage, limits and artifacts. Detailed attempt records live under `var/jobs/<id>/discovery`; candidate execution reports live under `verify/attempt-*/execution`. Delivery includes source, the discovered environment and acceptance plan, the generic runner, logs, diff and reproducible instructions.

```sh
GOOSE_TEST_DOCKER=1 var/venvs/engine/bin/python -m pytest -q tests/autonomy
npm test
npm run test:e2e
```
