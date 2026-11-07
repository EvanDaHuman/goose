# Goose Competitor Research: AI Modernization for Flask/SQLite → FastAPI/PostgreSQL

Researched on 2026-11-04

**Question.** If a business owns an aging Python/Flask + SQLite JSON API, what could it buy or use instead of Goose's fixed-price pilot? (The pilot: upgrade to FastAPI + PostgreSQL, migrate the data, check old-vs-new behaviour with frozen deterministic acceptance checks, and deliver code, migration files, test evidence and a rollback guide.)

**Method and evidence standard**

- **Primary sources only.** Every claim comes from the vendor's own product pages, docs, pricing pages, official blog posts or announcements, GitHub READMEs or source, or package and catalog metadata the vendor publishes. Web search was used only to find URLs. No third-party listicle was used for any claim.
- **How claims were checked.** All pages were fetched on 2026-11-04. Prices, supported languages, option names and counts were checked against the raw page text (curl plus text search). Where a site blocked automated fetching, the gap is noted and another official source was used (the vendor's docs Markdown, the GitHub source, or the README).
- **Read-only.** Nothing was signed up for, logged into, submitted or tested hands-on. "Supports X" means the vendor says so on the cited page, not that we confirmed it works.
- **Vendor numbers kept out.** Vendor-reported speed or savings figures are labelled as vendor claims and are not used in the analysis.
- **Quotations.** To limit copying of vendor text, the report contains one verbatim quote (in §8). Everything else is paraphrased. Prices and technical identifiers (option names, recipe IDs) are given exactly, as facts.

---

## Summary comparison

"Not named" means I found no mention on the vendor pages I opened. It does not prove the capability is missing.

| Competitor | What it is | Python/Flask→FastAPI? | SQLite→Postgres data? | Delivery model | Pricing (published?) | Source |
|---|---|---|---|---|---|---|
| **AWS Transform** (Amazon) | AWS agentic modernization service: free agents for mainframe, Windows/.NET and VMware, plus a paid custom agent for language, framework and SDK transformations | Python: **yes** (AWS-managed Python version upgrades). Flask→FastAPI: **not named**; would have to be written as your own custom transformation (unverified) | **No.** The only database path found is SQL Server → Aurora PostgreSQL schema conversion, in the Windows agent | Tool you operate (CLI, web console, IDE/MCP). AWS partners can deliver with it | **Yes.** Custom agent $0.035 per agent-minute. Workload agents free | [pricing](https://aws.amazon.com/transform/pricing/) |
| **GitHub Copilot modernization** (Microsoft/GitHub) | Copilot-based upgrade and migrate-to-Azure tooling (IDE extension plus Modernize CLI agent) | Python: **only** Semantic Kernel/AutoGen → Microsoft Agent Framework. Flask→FastAPI: **not named** | **No.** Java tasks adapt *app code* for Oracle/Db2/etc. → Azure PostgreSQL; no data copy described | Tool developers operate | **Partly.** No separate modernization price; needs a Copilot plan (Business $19/seat/month, Enterprise $39/seat/month) | [languages](https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/languages) |
| **Moderne / OpenRewrite** | Deterministic, recipe-based refactoring across whole code estates (OSS engine plus commercial platform and managed service) | Python: **yes, via commercial Moderne** (132 recipes: version bumps, dependencies, cleanup). Flask→FastAPI: **no migration recipe**, only find-endpoint analysis recipes | **No** | Platform (SaaS or on-prem) or fully managed service | **Yes, published as typical prices:** $250K / $2M / $5M (managed) | [pricing](https://www.moderne.ai/pricing) |
| **Cognition Devin** | Autonomous AI software engineer, marketed for large migrations | Python 2→3 listed. Flask→FastAPI **not named** (a general agent could attempt it) | **Claims database migrations, including moving data** (MongoDB→PostgreSQL, DynamoDB→MySQL). SQLite **not named** | Agent platform you operate | **Yes.** Free; Pro $20/mo; Max $200/mo; Teams $80/mo + $40/seat; Enterprise custom | [pricing](https://devin.ai/pricing) |
| **Factory** (factory.ai) | Agent-native development platform (*Droids*); markets migration and modernization | **Not named** | **Not named** (its Databricks example moves legacy Postgres → Lakebase) | Agent platform you operate | **Yes.** Pro $20; Plus $100; Max $200; Teams $60/team + $40/seat; Business and Enterprise custom | [pricing](https://factory.ai/pricing) |
| **Mechanical Orchard** | Mainframe modernization. The Imogen platform plus their team rewrite code and verify equivalence against production behaviour | **No** (mainframe → Java) | **No** | Platform plus their team, often via system integrators; free PoC | **Model published, amounts not.** Credits based on lines of code × difficulty, billed only on proven equivalence | [priced on proof](https://www.mechanical-orchard.com/insights/priced-on-proof) |
| **pgloader** (open source) | Bulk data and schema loader into PostgreSQL | **No** (no application code) | **Yes, explicitly.** SQLite file → PostgreSQL schema, data, indexes and sequences | Do-it-yourself tool | **Free** (PostgreSQL Licence). Optional support €100–€2,000/month | [pgloader.io](https://pgloader.io/) |
| **General coding agents** (Claude Code, OpenAI Codex, Cursor) | General-purpose agents a developer drives | Any stack, operator-driven; nothing packaged | Can write migration scripts if asked; nothing packaged | Tool you operate | **Yes.** About $0–$200/month for individual tiers (Codex Pro goes to $500); team seats from about $20/user/month | [Claude](https://claude.com/pricing), [Codex](https://developers.openai.com/codex/pricing), [Cursor](https://cursor.com/pricing) |
| **Freelancers / agencies** (example: Boldare) | People-delivered modernization, increasingly AI-assisted | Varies by vendor. Boldare lists PHP/Symfony/Java/.NET, not Python | Varies; not specified by Boldare | Done-for-you | **Usually quote-based.** Boldare sells fixed-price phases but publishes no amounts | [Boldare](https://www.boldare.com/services/legacy-modernization-with-ai) |

---

## 1. AWS Transform (Amazon)

- **What it does.** An AWS service that uses AI agents for migration and modernization.
  - **Free workload agents:** assessment, mainframe, Windows/.NET (including SQL Server) and VMware.
  - **Custom agent (paid):** applies language, framework, API/SDK and architecture transformations to repositories through the `atx` CLI. A web app runs multi-repo *campaigns*.
  - **Continuous modernization:** finds and fixes tech debt such as end-of-life dependencies and vulnerabilities.
- **Supported stacks.**
  - **Python: yes.** There is an AWS-managed `AWS/python-version-upgrade` transformation; the docs example is Python 3.9 → 3.13. The docs' pattern table also lists Boto2→Boto3, Django upgrades, Pandas 1.x→2.x, print→logging, type-hint adoption, Java→Python and Python→Go.
  - **Flask→FastAPI: not named** on any AWS page I opened. The docs rate *framework migrations* as high complexity, and their examples are JavaScript frameworks (Angular→React, Vue.js→React, Redux→Zustand). You can write your own transformation definition in natural language (a `SKILL.md` plus references and scripts). So Flask→FastAPI would be a self-written custom transformation. Feasibility and quality are unverified.
  - **SQLite→PostgreSQL data: not named.** The only database-to-PostgreSQL path found is in the Windows agent: SQL Server → Amazon Aurora PostgreSQL schema conversion, plus refactoring of the dependent .NET code (Entity Framework config, connection strings).
- **Delivery model.** A tool or service you operate:
  - CLI, interactive or headless, scriptable across many repos and usable in CI/CD.
  - Web console for campaigns.
  - Access from Kiro, Claude, Cursor and Codex through a Kiro power, agent plugins and an MCP server.
  - AWS also lists AWS Transform partners who deliver modernization using it.
- **Who it targets.** Enterprises and platform teams modernizing many applications in parallel. The custom agent went GA on 2025-12-01, launching in US East (N. Virginia).
- **Pricing (published).**
  - Assessment and the Windows, mainframe and VMware agents: **free**.
  - Custom transformation agent: **$0.035 per agent-minute**, minimum billing increment 1 minute. Idle time and client-side work (builds, tests, file reads) are not billed.
  - AWS-managed .NET transformation inside the custom agent: free up to **50,000 agent-minutes/month**.
  - Continuous modernization: paid, in agent minutes.
  - AWS's own worked example: a Python runtime upgrade of about 4,000 LOC takes about 37 agent-minutes, roughly **$1.30**.
  - The pricing FAQ says agent minutes are charged even when the result doesn't pass validation.
- **Evidence and verification.**
  - You supply build or validation commands (the docs' Python examples are `pytest` and `python -m py_compile`). The agent uses builds and tests to validate, and sends failures back for a fix or flags them for review.
  - Interactive mode allows human review and feedback. The docs tell you to review the Git diff and run your test suite after each run. *Continual learning* turns past runs into reusable lessons.
  - If it can't finish, AWS says it returns the in-progress files plus guidance.
  - The main page stresses tracing changes from source to target and human review at each step, mostly in the mainframe context.
  - **Not found:** rollback guidance, data validation, or a packaged old-vs-new behavioural comparison for custom transformations.
- **History.** Amazon Q Developer's Transform page still lists .NET porting and Java upgrades and points Java upgrades to AWS Transform custom. The AWS Transform pricing FAQ says the .NET agent is also available in Amazon Q Developer. I found no official statement that one product formally replaced the other.
- **Sources opened.**
  - https://aws.amazon.com/transform/
  - https://aws.amazon.com/transform/custom/
  - https://aws.amazon.com/transform/pricing/
  - https://aws.amazon.com/transform/windows/
  - https://aws.amazon.com/transform/partners/
  - https://docs.aws.amazon.com/transform/latest/userguide/custom.html
  - https://docs.aws.amazon.com/transform/latest/userguide/custom-workflows.html
  - https://docs.aws.amazon.com/transform/latest/userguide/custom-common-use-cases.html
  - https://docs.aws.amazon.com/transform/latest/userguide/what-is-service.html
  - https://aws.amazon.com/about-aws/whats-new/2025/12/transform-custom-organization-wide-modernization/
  - https://aws.amazon.com/q/developer/transform/
- **Could not verify.**
  - Whether a Flask→FastAPI custom transformation works, or what it would cost.
  - The current region list.
  - Partner pricing.
  - Whether AWS terms allow a non-partner third party to run AWS Transform on a customer's code as a paid service.

## 2. GitHub Copilot modernization (Microsoft/GitHub; formerly *app modernization*)

- **What it does.** Microsoft's agentic modernization built on GitHub Copilot. Microsoft Learn now titles it *GitHub Copilot modernization*, though the URLs still say app-modernization. It has two layers:
  - **IDE experience** (VS Code; Visual Studio for .NET): upgrades, code changes for moving to Azure services, containerization, infrastructure-as-code and deployment.
  - **Modernization agent** (Modernize CLI): assessment and migration planning across many applications at once.
- **Supported stacks.**
  - **Generally available:** upgrades for .NET, Java and C++, and migration of .NET and Java apps to Azure. npm package upgrades for JavaScript/TypeScript are also documented.
  - **Python:** the only scenario is migrating a Python app from Semantic Kernel or AutoGen to Microsoft Agent Framework. Containerization and Azure deployment work for any language.
  - **Flask→FastAPI: not named.**
  - **SQLite→PostgreSQL data: not named.** Java predefined tasks update *application code* for moves from Oracle, IBM Db2, Informix or Sybase to Azure Database for PostgreSQL or Azure SQL (passwordless auth, SQL dialect, data types). That is code-side work; no data transfer is described.
- **Delivery model.** A tool developers run in the IDE or CLI, with humans in the loop.
- **Who it targets.** Developers and architects modernizing toward Azure.
- **Pricing (published).**
  - No separate modernization price found. The agent quickstart requires a GitHub Copilot subscription and lists the Free, Pro, Pro+, Business and Enterprise plans.
  - Copilot list prices (GitHub docs, 2026-11-04): Pro **$10/month**, Pro+ **$39/month**, Max **$100/month**, Business **$19 per granted seat/month**, Enterprise **$39 per granted seat/month**.
  - Chat and agent usage draws on GitHub AI Credits ($0.01 each), with a monthly allowance in each plan.
- **Evidence and verification.**
  - Build validation with automatic fixes, test validation, migration of unit tests, and CVE scans after upgrades.
  - The Python flow sets up a virtual environment, installs dependencies, then runs syntax, lint and test checks, and finishes with a migration summary that includes validation results.
  - It uses OpenRewrite for some code upgrades.
  - **Not found:** rollback.
- **Dates.** The languages and overview pages show last updated 2026-06-12; the quickstart is dated 2026-06-02.
- **Sources opened.**
  - https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/overview
  - https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/languages
  - https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/modernization-agent/quickstart
  - https://learn.microsoft.com/en-us/azure/developer/java/migration/migrate-github-copilot-app-modernization-for-java-predefined-tasks
  - https://github.com/features/copilot/plans
  - https://docs.github.com/en/copilot/get-started/plans
- **Could not verify.**
  - How many AI credits a typical modernization run uses.
  - Any plan for Python web-framework scenarios. The FAQ URL I tried returned 404.

## 3. Moderne / OpenRewrite

- **What it does.**
  - **OpenRewrite** is an open-source refactoring engine. It applies deterministic *recipes* to Lossless Semantic Trees of the code and keeps the original formatting.
  - **Moderne** sells the commercial platform that runs recipes across a whole code estate: a multi-repo CLI, a SaaS platform, the air-gapped *Moderne DX*, agent tools (Trigrep, Prethink) and an MCP server. It also sells a *Managed Service* staffed by forward-deployed engineers.
- **Is Python supported? Yes, but through commercial Moderne, not open-source OpenRewrite.**
  - OpenRewrite's supported-languages page (dated June 2026) lists Java, Kotlin and Groovy, and says Moderne offers more languages, including Python.
  - OpenRewrite's licensing page says the Python language module is under the *Moderne Source Available License*, not Apache 2.0.
  - **Python capabilities.** Moderne's Python page lists:
    - runtime upgrades
    - `pyproject.toml` dependency management
    - CVE remediation
    - deprecated-API modernization
    - import restructuring
    - symbol and pattern audits

    It also says more version-to-version paths are coming.
  - **Recipe catalog.** Moderne's public catalog (Code Genome Project CSV, last modified 2026-11-03) has **132 recipes** under `org.openrewrite.python`. They cover:
    - Python version bumps in project files (3.8 through 3.15)
    - Docker and CloudFormation runtime bumps
    - adding, changing and upgrading dependencies
    - moving to `pyproject.toml`
    - roughly 90 cleanup and code-quality rules
    - a vulnerable-dependency check and an SBOM
- **Flask→FastAPI: no migration recipe.** The only Flask, FastAPI or ORM entries are analysis recipes in Prethink: `FindFlaskEndpoints`, `FindFastAPIEndpoints` and `FindSQLAlchemyModels`.
- **SQLite→PostgreSQL: none.** The only catalog entry mentioning SQLite is an unrelated Android/Kotlin recipe.
- **Delivery model.** A platform you operate (SaaS/hybrid, or on-prem with DX), or the done-for-you Managed Service. The managed service runs continuously: Moderne commits to the outcome and reports on what changed.
- **Who it targets.** Large enterprises; the tiers are sized by developer count and lines of code.
- **Pricing (published as typical amounts).**
  - **Commercial: $250K.** Up to about 1,000 developers and hundreds of repos; includes one part-time forward-deployed engineer.
  - **Enterprise: $2M.**
  - **Fully Managed Service: $5M.**
  - **Backpatch Alliance membership: $2,000/month.**
  - The open-source OpenRewrite core (Apache 2.0) is free.
- **Evidence and verification.**
  - Deterministic recipes produce the same diff on every run. Changes arrive as reviewable pull requests in your existing CI/CD.
  - The Python page says transformations are auditable and reversible; DevCenter tracks progress across repos.
  - Compile or test failures in one repo are fed back to improve the recipe.
  - In the managed service, engineers review every diff before it merges.
  - **Not found:** any data-migration verification.
- **Licensing note that matters for Goose.** The licensing page says source-available modules and recipes, which include the Python module, may not be commercialized or offered as a managed service. It explicitly rules out charging others for consulting in which you run these recipes. Proprietary recipes are only for Moderne customers.
- **Sources opened.**
  - https://www.moderne.ai/
  - https://www.moderne.ai/pricing
  - https://www.moderne.ai/solutions/python-change-and-transformation
  - https://www.moderne.ai/managed-service
  - https://docs.openrewrite.org/
  - https://docs.openrewrite.org/reference/supported-languages
  - https://docs.openrewrite.org/licensing/openrewrite-licensing
  - https://artifacts.codegenomeproject.org/recipes.csv (the data behind https://codegenomeproject.org/recipes?q=org.openrewrite.python)
  - https://pypi.org/project/openrewrite/ (read through the PyPI JSON API)
- **Could not verify.**
  - How good the Python recipes are in practice. The `openrewrite` PyPI package (version 8.97.1, uploaded 2026-11-03) is classified as Beta.
  - Whether Moderne would take a tiny single-app engagement.

## 4. Cognition Devin

- **What it does.** Cognition's autonomous AI software engineer:
  - **Devin Cloud:** the cloud agent.
  - **Desktop and IDE:** Devin Desktop and Tab completions.
  - **Integrations:** web app, Slack/Teams, Linear/Jira, GitHub/GitLab/Bitbucket and an API.

  Cognition markets large migrations split into parallel sessions using reusable *skills*.
- **Supported stacks.**
  - **Migrations listed in the docs' use-case library:**
    - version and framework upgrades: Java 8→17, **Python 2→3**, PHP 7→8, Angular and React upgrades, Spring Boot 2→3, .NET Framework→.NET
    - code migrations: JS→TS, PySpark
    - COBOL/SAS → Python/Java
    - cloud-to-cloud migrations
    - database code migrations: MongoDB→PostgreSQL, DynamoDB→MySQL
  - **Data migration is claimed.** The NoSQL→SQL page says Devin can design the relational schema, transform and migrate the data, and update the application code.
  - **Flask→FastAPI: not named.**
  - **SQLite→PostgreSQL: not named.**
- **Delivery model.** An agent platform you operate. A human scopes the work, manages it and approves Devin's pull requests. Enterprise adds dedicated account and engineering support, VPC deployment and SAML/OIDC SSO.
- **Who it targets.** Individuals through enterprises. The use-case guide focuses on large enterprise projects that split into many repetitive tasks.
- **Pricing (published).**
  - Free: **$0**
  - Pro: **$20/month**
  - Max: **$200/month**
  - Teams: **$80/month** for the team plan **+ $40/month per full dev seat**, up to 200 users
  - Enterprise: by contact
  - Usage beyond the included quota is bought at API pricing.
- **Evidence and verification.**
  - The docs say Devin works best when success can be checked objectively: CI passing, unit tests, or browser tests of user flows.
  - The NoSQL→SQL page mentions migration scripts with data validation.
  - A .NET tutorial (2025-10-28) describes running test harnesses on every PR during a strangler-fig migration.
  - A COBOL post (2026-04-08) describes rebuilding batch logic and checking it against known expected outputs.
  - **Not found:** rollback.
- **Case studies.**
  - **Nubank:** splitting an 8-year-old ETL monolith of several million lines into sub-modules, about 100,000 data-class migrations. The page publishes efficiency and cost-savings multiples that Cognition calculated, with the method described on the page. Not independently verified.
  - The COBOL post describes unnamed Fortune 500 users.
- **Sources opened.**
  - https://devin.ai/pricing
  - https://devin.ai/customers
  - https://devin.ai/customers/nubank
  - https://docs.devin.ai/use-cases/index
  - https://docs.devin.ai/use-cases/migration-modernization
  - https://docs.devin.ai/use-cases/examples/nosql-to-sql
  - https://docs.devin.ai/enterprise/use-cases/menu
  - https://cognition.ai/blog/dotnet-migration-with-devin
  - https://cognition.ai/blog/how-devin-is-modernizing-cobol-at-fortune-500-companies
- **Could not verify.**
  - Independent outcomes.
  - Whether Enterprise is still billed in compute units (the pricing page doesn't say).
  - Any Flask- or SQLite-specific example.

## 5. Factory (factory.ai)

- **What it does.** An agent-native software development platform.
  - **Droids** run across desktop, CLI, web and an SDK.
  - **Platform features:** Missions (planned multi-step work), Automations, code review, AutoWiki, analytics, model routing and dedicated *Droid Computers*.
  - **Migration claims:** a headline migration metric on its enterprise page, and a Databricks partnership (2026-10-19) that covers migrating data platforms and the applications that depend on them.
- **Supported stacks.**
  - **No language or framework support matrix** for migrations found.
  - **Databricks example:** moving an operational database from legacy Postgres to Databricks Lakebase, rewriting data transformations in Python, then comparing the new application and its data with the legacy one.
  - **Legacy-Bench:** Factory's benchmark (2026-09-24) tests models on COBOL, Java 7, BASIC, C89, Fortran and Assembly.
  - **Flask→FastAPI and SQLite→PostgreSQL: not named.**
- **Delivery model.** A platform you operate. Enterprise adds a dedicated account manager and customer engineer, an agent-readiness improvement program, and on-prem options.
- **Who it targets.** Individuals through large enterprises; the messaging is mostly about enterprises.
- **Pricing (published).**
  - Pro: **$20/month**
  - Plus: **$100/month**
  - Max: **$200/month**
  - Teams: **$60/month per team + $40/month per seat**, up to 10 seats
  - Business and Enterprise: by contact
- **Evidence and verification.**
  - Droids plan, build and validate changes.
  - In the Databricks post, Droids help define compatibility checks, run queries to validate results, and compare the new system with the legacy one. Engineers review the plan and settle ambiguous business rules before implementation.
  - The enterprise page shows a vendor-reported migration-time reduction figure with no method on that page.
  - **Not found:** rollback.
- **Sources opened.**
  - https://factory.ai/
  - https://factory.ai/pricing
  - https://factory.ai/enterprise
  - https://factory.ai/news
  - https://factory.ai/news/databricks-partnership
  - https://factory.ai/news/legacy-bench-specialized-intelligence-index
  - https://docs.factory.com/llms.txt
- **Could not verify.**
  - Details of any migration customer case study (I did not open Factory's case-study pages).
  - What the enterprise migration figure is based on.
  - Business and Enterprise prices.

## 6. Mechanical Orchard

- **What it does.** A mainframe modernization company. Its Imogen platform works in three stages:
  - **Analyze:** reads the legacy code deterministically.
  - **Rewrite:** generates modern code slice by slice (the PoC produces a Java replica) and verifies it against real production data flows.
  - **Orchestrate:** runs old and new side by side, so there is no big-bang cutover.
- **Supported stacks.** Mainframe technologies listed on the platform page: Easytrieve, PL/1, Assembler, CICS, IMS, ISAM, IDMS, DB2 and VSAM; COBOL appears throughout the site. **No Python, Flask or SQLite.**
- **Delivery model.**
  - The platform plus Mechanical Orchard's own team, often working with system integrators.
  - Integrates with AWS Transform and Google MAT. For AWS Transform clients, Imogen handles the validation part.
  - **Free proof of concept:** done in days, under NDA, in a cloud environment Mechanical Orchard controls. It delivers a roadmap and a characterization-tested Java replica of about 100k LOC.
- **Who it targets.** Large enterprises and government; the testimonials come from Fortune 20, 100 and 500 companies.
- **Pricing.** **No dollar amounts are published.** The pricing *model* is published (blog, 2026-10-22):
  - A fixed number of *Imogen Credits* is quoted before work starts: lines of code × a difficulty surcharge. Plain COBOL batch is the reference point, at 1 credit per line.
  - Billing counts only code accepted as proven equivalent, never seats, time, tokens or attempts.
  - The dollar rate per credit is negotiated, with volume discounts; system-integrator partners commit to pools of credits.
- **Evidence and verification.** The strongest verification story in this set:
  - **Continuous equivalence:** given the same inputs, the new system must produce the same outputs as the running legacy system, checked continuously.
  - **Production-derived tests:** the test suite comes from observed production behaviour.
  - **Cutover checklist** (blog, 2026-09-17): buyers should demand evidence on five points:
    - business correctness on real transactions
    - performance at peak load
    - integration with systems that weren't modernized
    - whether their own team can support the code
    - user acceptance testing
  - Rollback isn't described explicitly; running old and new side by side is the risk control.
  - The pricing post says data migration stays with the system integrator.
- **Sources opened.**
  - https://www.mechanical-orchard.com/
  - https://www.mechanical-orchard.com/platform
  - https://www.mechanical-orchard.com/insights/priced-on-proof
  - https://www.mechanical-orchard.com/case-study/see-imogen-work-on-your-code
  - https://www.mechanical-orchard.com/insights/the-cutover-checklist
  - https://www.mechanical-orchard.com/about-us
- **Could not verify.**
  - The price per credit.
  - Whether they take non-mainframe work.

## 7. pgloader (the do-it-yourself data-move baseline)

- **What it does.** An open-source tool, maintained since 2005 by Dimitri Fontaine, that loads data into PostgreSQL using COPY. It migrates schema and data from SQLite files, MySQL/MariaDB, MS SQL Server, and CSV, DBF or fixed-width files. Oracle support has never been built; funding is being sought.
- **Supported stacks.**
  - **SQLite→PostgreSQL: yes, explicitly.** One command pointed at a `.db` file discovers the schema, creates tables and indexes, copies the data and resets sequences.
  - **Default `WITH` options:** `no truncate`, `create tables`, `include drop`, `create indexes`, `reset sequences`, `downcase identifiers`, UTF-8 encoding.
  - **Default casts:**
    - `integer`→`bigint`, `tinyint`→`smallint`
    - `char`/`varchar`/`nvarchar`/`clob`→`text`
    - `blob`→`bytea`
    - `datetime`/`timestamp`→`timestamptz`
    - `decimal`/`numeric`→`numeric`
  - Custom CAST rules and include/exclude table filters are supported.
  - **Flask→FastAPI:** not applicable; it doesn't touch application code.
- **Delivery model.** A do-it-yourself tool.
  - **v3** (Common Lisp) is the stable packaged release; the latest GitHub release is v3.6.9, dated 2022-10-24.
  - **v4** (a Clojure rewrite: single JAR, needs Java 21+) is pre-release.
  - The repo was last pushed on 2026-09-14.
- **License.** The PostgreSQL Licence, which is permissive, so it can be used inside a paid service.
- **Pricing (published).**
  - The tool is free.
  - **Optional support:** Supporter **€100/month**, Professional **€800/month**, Sponsor **€2,000/month**, Per-Release Sponsor **€10,000/release**, Fast-Lane **€3,000/issue**.
  - **Courses:** migration courses at **$79** each.
  - **Custom migration help:** through a network of professionals; no price given.
- **Evidence and verification.**
  - Every run prints a per-table report of row counts, bytes and timings.
  - Rejected rows go to a separate file while good rows keep loading.
  - **Not provided:** value-level diffs, application-behaviour checks, or rollback.
  - The docs warn that `include drop` uses CASCADE, and that `disable triggers` can leave foreign keys invalid.
- **Sources opened.**
  - https://pgloader.io/
  - https://pgloader.io/support/
  - https://pgloader.readthedocs.io/en/latest/ref/sqlite.html (read through a summarizing fetch, because readthedocs served a bot challenge to curl; facts checked against the raw docs source at https://github.com/dimitri/pgloader/blob/master/docs/ref/sqlite.rst)
  - https://github.com/dimitri/pgloader (README)
  - https://api.github.com/repos/dimitri/pgloader/releases/latest
- **Could not verify.** Whether SQLite handling differs between v3 and v4.

## 8. General coding agents (Claude Code, OpenAI Codex, Cursor): the "give it to a coding agent" alternative

**What they have in common.**
- General-purpose agents that a developer runs in a terminal, IDE or the cloud.
- They work on any stack, including Python, Flask, FastAPI and SQL.
- Verification is whatever the operator asks for or already has, such as tests or CI.
- **Not offered:** none of the pages I opened offers a fixed price for an outcome, a data-migration check, or a rollback plan as a deliverable.

- **Claude Code (Anthropic).**
  - **Positioning:** the product page pitches migrations directly: "Hand Claude a bug fix, test, or multi-day migration." It also says Claude Code runs multi-hour refactors and migrations, follows imports across the repo, runs your tests and keeps going when something breaks, and opens PRs through GitHub/GitLab.
  - **Pricing** (claude.com/pricing):
    - Included from **Pro: $17/month** billed annually, or $20 monthly.
    - **Max: $100/month.**
    - **Ultra: $200/month.**
    - **Team:** standard seat **$20/seat/month** annually ($25 monthly); premium seat **$100/seat/month** annually ($125 monthly).
    - **Enterprise:** **$20/seat/month** annually plus usage at API rates, 20-seat minimum.
- **OpenAI Codex.**
  - **Positioning:** the GitHub README describes Codex CLI as OpenAI's coding agent that runs locally. It is also available as an IDE extension, a desktop app and the cloud-based Codex Web.
  - **Pricing** (developers.openai.com/codex/pricing):
    - **Free: $0**
    - **Go: $8/month**
    - **Plus: $20/month**
    - **Pro: from $100/month** (tiers at $100, $200 and $500)
    - **Business: $20/user/month** billed annually, 2+ users ($25 monthly)
    - **Enterprise/Edu:** by contact
    - API-key usage is billed at API prices.
- **Cursor.**
  - **Positioning:** a coding agent and editor with desktop, CLI and cloud agents.
  - **Pricing:** on 2026-11-04 the pricing page bundles X/Grok consumer features:
    - **Free: $0**
    - **Plus: $8/month** (Grok models only)
    - **Premium: $30/month**
    - **Super: $100/month**
    - **Ultra: $200/month**
    - **Teams: $30+/user/month**
    - **Enterprise:** custom
    - Third-party model usage is billed separately.
- **Sources opened.**
  - https://claude.com/product/claude-code
  - https://claude.com/pricing
  - https://developers.openai.com/codex/pricing
  - https://github.com/openai/codex (README)
  - https://cursor.com/
  - https://cursor.com/pricing
- **Could not verify.**
  - https://openai.com/codex/ returned 403 to automated fetch, so the OpenAI developer docs and the GitHub README were used instead.
  - None of the agents was tested on a Flask→FastAPI job.

## 9. Traditional option: freelancers and agencies

- **What it is.** People do the work for you. Pricing is usually hourly (time and materials) or a fixed bid after scoping. How carefully the work is verified, and whether there is a rollback plan, depends on the person or firm.
- **Example with a primary source: Boldare's AI-assisted legacy modernization service.**
  - **Readiness scan:** fixed price, 3–5 business days, credited toward later work.
  - **Migration sprints:** about 4 weeks per module or phase, priced either fixed per module/phase or as milestone-based time and materials.
  - **Method:** AI agents do the code transformation, documentation and test coverage, with human approval at each checkpoint, and feature flags allow an incremental cutover.
  - **Deliverable:** a before/after test-coverage report.
  - **Stacks listed:** PHP, Symfony, Java and .NET. Python is not listed.
  - **No amounts are published.**
- **Sources opened.** https://www.boldare.com/services/legacy-modernization-with-ai
- **Could not verify.** Marketplace rates. Upwork returned 403 and Toptal served a bot challenge to automated fetching, so no freelancer rate data is included.

## Also checked (no full profile)

- **Codemod** (codemod.com): a codemod platform with an open-source CLI and registry, plus paid Studio, Campaigns and Insights.
  - **Pricing:** Community **$0**; Team **from $1k/month**; Enterprise custom.
  - **Languages:** the docs index lists JS/TS, Java and XML helpers. **Python support not verified.**
  - **Sources:** https://codemod.com/pricing, https://docs.codemod.com/llms.txt
- **Codegen:** a search result pointed to a Flask→FastAPI tutorial on docs.codegen.com. On 2026-11-04 that page returned Page Not Found, and Codegen's docs now describe a general coding-agent product.
  - **Source:** https://docs.codegen.com/tutorials/flask-to-fastapi
- **Not covered:** Google (Gemini Code Assist, Jules), IBM watsonx Code Assistant, Kiro, Replit, and large systems integrators.

---

## Analysis

### Where Goose's narrow offer genuinely differs (verified facts only)

**What no vendor packages.** Across every vendor page I opened:
- **Flask→FastAPI plus SQLite→PostgreSQL:** none offers this as a packaged, supported path. AWS packages Python *version* upgrades, Moderne's Python recipes cover upgrades and cleanup, and Copilot modernization's Python support is one Agent Framework scenario.
- **Rollback guide:** none promises one. Only Moderne describes its changes as reversible.
- **Old-vs-new behavioural evidence as a deliverable:** comparing the new system's behaviour with the old one's is *described* by Mechanical Orchard (the core of its product), Factory (its Databricks example) and Cognition (its COBOL batch post). Only Mechanical Orchard makes it the basis of what it sells and bills for.

How each competitor compares:

- **AWS Transform.** AWS sells agent minutes to teams who run the tool and supply their own validation commands. Its packaged Python offering is version upgrades; there is no advertised Flask→FastAPI path and no SQLite data handling. Goose differs by owning the whole outcome (code, data, acceptance evidence, rollback guide) at a fixed price.
- **GitHub Copilot modernization.** Its Python coverage is one narrow scenario and it is built around Azure; it doesn't handle this stack or the data move. Goose differs on both the stack and the service model.
- **Moderne.** Deterministic and built for enterprise scale, but it has no Flask→FastAPI recipe and no data migration. Its published typical prices start at $250K. Goose serves a buyer and job size well below Moderne's published tiers. Its managed service is done-for-you but sold as an ongoing enterprise engagement.
- **Devin and Factory.** Both could attempt this job, and Devin's docs explicitly claim data migrations. But both are platforms the buyer operates, and neither publishes a fixed price per outcome or a defined evidence pack. Goose differs on who does the work and what is guaranteed.
- **Mechanical Orchard.** Closest in philosophy: verify equivalence against observed behaviour, price on proven outcomes, run old and new side by side. But it is mainframe-only and enterprise-only, with no published price. It is a useful positioning reference for Goose, not a rival today.
- **pgloader.** Solves only the data step, for free. Goose differs by also migrating the code and proving the app behaves the same, and pgloader's permissive license means Goose can use it inside its pipeline.
- **General coding agents.** The capability underneath is the same; Claude Code's own page offers multi-day migrations. The difference is who operates the agent, who is accountable, and what gets delivered, not what the models can do.
- **Agencies.** Also done-for-you, and at least one (Boldare) already sells AI-assisted, fixed-price phases with before/after test reports. Goose's difference is narrower: one standardized stack, a fixed pilot price and a standard evidence pack. I could not verify agency prices to compare.

### Where competitors are clearly stronger

- **Cost for a buyer who has a developer.**
  - AWS's own example puts a roughly 4,000-LOC Python runtime upgrade at about $1.30 of agent time.
  - pgloader is free.
  - Coding-agent plans cost $0–$200/month per person, with OpenAI's top Codex Pro tier at $500.
  - Any Goose fixed price will be far above the raw tool cost, so it has to be justified by labour saved and assurance, not compute.
- **Breadth and scale.** AWS, Microsoft and Moderne run portfolio-wide campaigns across many languages and hundreds of repos. AWS and Moderne also offer continuous modernization, not one-off projects.
- **Brand, trust and compliance.**
  - **Brand:** AWS, Microsoft/GitHub and Anthropic/OpenAI.
  - **Analyst rankings:** AWS says it was named a Leader in the 2026 Gartner Magic Quadrant for AI Augmented Code Modernization Tools. Moderne says it was named a Leader in the first edition of that Magic Quadrant. These are vendor statements; I did not read the report.
  - **Certifications:** Mechanical Orchard cites ISO/IEC 27001:2022.
  - **Enterprise controls:** Devin, Factory, Codex and Claude list SSO, VPC or on-prem deployment, audit logs and data controls.
- **Track record.** Published customer stories exist: Nubank on Devin's site, Fortune-company testimonials on Mechanical Orchard's site, and customers on AWS's pages. Goose has none yet.
- **Determinism.** Moderne's recipes produce the same diff on every run. An agent-built migration doesn't by default; Goose's frozen acceptance checks only partly make up for that.
- **Distribution.** Copilot sits inside developer workflows. AWS Transform is callable from Claude, Cursor and Codex via plugins and MCP, and AWS has a partner network. Moderne and Mechanical Orchard sell through systems integrators.

### Why would a customer hire Goose instead of giving the task to an existing coding agent?

**The plain answer.** Because a coding agent is a tool and Goose would be selling a result. Every agent page I checked describes something a developer drives and reviews. The verification they mention is the customer's own tests and CI. None offers a fixed price, a data-migration check or a rollback plan. A customer would reasonably choose Goose when these hold:

1. **No developer time to spare.** They lack, or don't want to spend, developer time to run the agent, review its diffs, stand up PostgreSQL, move and check the data, and decide when the job is really done. The subscription is cheap; the supervising human's time has no cap.
2. **They want a fixed price.** With a fixed price, Goose carries the cost of overruns and failed attempts. AWS's pricing FAQ says agent minutes are billed even when a transformation fails validation; self-run tools leave that risk with the customer.
3. **They want proof that doesn't come from the code's author.** Goose freezes acceptance checks from the old app's behaviour *before* changing anything, runs them against old and new, and adds data checks and a rollback guide. That gives a non-technical owner a pack they can actually sign off on. Mechanical Orchard's cutover checklist shows that serious buyers ask for exactly this kind of evidence, though in a mainframe setting.
4. **The data move and cutover are included.** General agents don't package these.

**When Goose is the wrong choice.** If the buyer has a capable developer with time, Claude Code, Codex or Cursor plus pgloader can probably do most of this job for the price of a subscription. Goose would then be selling only time saved and assurance.

**Honest caveats.**
- Goose will probably use these same agents underneath. The edge is process, accountability and evidence, not model capability, and it only holds if the acceptance checks really are rigorous.
- The edge is easy to copy: agencies already sell AI-assisted fixed-price phases, AWS has partners, and Devin already claims data migrations.
- Supporting a single stack makes the work repeatable and fixed-price-able. It also limits what Goose can sell until more stacks are added. I did not size that market.

### Practical notes for Goose (from the facts above)

- **Licensing.**
  - Don't build the paid pipeline on Moderne's source-available Python recipes without a commercial agreement; the license excludes paid services.
  - pgloader's PostgreSQL Licence is permissive.
  - I did not verify whether AWS's terms allow a non-partner to run AWS Transform on a customer's code as a service.
- **pgloader defaults need explicit handling and evidence.** Watch `integer`→`bigint`, text types→`text`, `datetime`→`timestamptz`, and the warnings about `include drop` and `disable triggers`. pgloader's per-table row counts are a starting point, not full data verification.
- **Mechanical Orchard is the best positioning reference.** Billing only for proven equivalence, plus a buyer-facing cutover checklist, is close to Goose's model, applied to a different market.

---

## Sources

All of these were opened on 2026-11-04. Where noted, an alternative format (Markdown docs, raw source, an API) was read.

**AWS Transform**
- https://aws.amazon.com/transform/
- https://aws.amazon.com/transform/custom/
- https://aws.amazon.com/transform/pricing/
- https://aws.amazon.com/transform/windows/
- https://aws.amazon.com/transform/partners/
- https://docs.aws.amazon.com/transform/latest/userguide/custom.html (read as `.md`)
- https://docs.aws.amazon.com/transform/latest/userguide/custom-workflows.html (read as `.md`)
- https://docs.aws.amazon.com/transform/latest/userguide/custom-common-use-cases.html
- https://docs.aws.amazon.com/transform/latest/userguide/what-is-service.html (read as `.md`)
- https://aws.amazon.com/about-aws/whats-new/2025/12/transform-custom-organization-wide-modernization/
- https://aws.amazon.com/q/developer/transform/

**GitHub Copilot modernization**
- https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/overview
- https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/languages
- https://learn.microsoft.com/en-us/azure/developer/github-copilot-app-modernization/modernization-agent/quickstart
- https://learn.microsoft.com/en-us/azure/developer/java/migration/migrate-github-copilot-app-modernization-for-java-predefined-tasks
- https://github.com/features/copilot/plans
- https://docs.github.com/en/copilot/get-started/plans

**Moderne / OpenRewrite**
- https://www.moderne.ai/
- https://www.moderne.ai/pricing
- https://www.moderne.ai/solutions/python-change-and-transformation
- https://www.moderne.ai/managed-service
- https://docs.openrewrite.org/
- https://docs.openrewrite.org/reference/supported-languages
- https://docs.openrewrite.org/licensing/openrewrite-licensing
- https://codegenomeproject.org/recipes?q=org.openrewrite.python (page loads dynamically; data read from https://artifacts.codegenomeproject.org/recipes.csv)
- https://pypi.org/project/openrewrite/ (read through https://pypi.org/pypi/openrewrite/json)

**Cognition Devin**
- https://devin.ai/pricing
- https://devin.ai/customers
- https://devin.ai/customers/nubank
- https://docs.devin.ai/use-cases/index (read as `.md`)
- https://docs.devin.ai/use-cases/migration-modernization (read as `.md`)
- https://docs.devin.ai/use-cases/examples/nosql-to-sql (read as `.md`)
- https://docs.devin.ai/enterprise/use-cases/menu (read as `.md`)
- https://cognition.ai/blog/dotnet-migration-with-devin
- https://cognition.ai/blog/how-devin-is-modernizing-cobol-at-fortune-500-companies

**Factory**
- https://factory.ai/
- https://factory.ai/pricing
- https://factory.ai/enterprise
- https://factory.ai/news
- https://factory.ai/news/databricks-partnership
- https://factory.ai/news/legacy-bench-specialized-intelligence-index
- https://docs.factory.com/llms.txt

**Mechanical Orchard**
- https://www.mechanical-orchard.com/
- https://www.mechanical-orchard.com/platform
- https://www.mechanical-orchard.com/insights/priced-on-proof
- https://www.mechanical-orchard.com/case-study/see-imogen-work-on-your-code
- https://www.mechanical-orchard.com/insights/the-cutover-checklist
- https://www.mechanical-orchard.com/about-us

**pgloader**
- https://pgloader.io/
- https://pgloader.io/support/
- https://pgloader.readthedocs.io/en/latest/ref/sqlite.html (summarizing fetch; raw source: https://github.com/dimitri/pgloader/blob/master/docs/ref/sqlite.rst)
- https://github.com/dimitri/pgloader (README)
- https://api.github.com/repos/dimitri/pgloader/releases/latest

**General coding agents**
- https://claude.com/product/claude-code
- https://claude.com/pricing
- https://developers.openai.com/codex/pricing (read as `.md`)
- https://github.com/openai/codex (README)
- https://openai.com/codex/ (attempted; 403)
- https://cursor.com/
- https://cursor.com/pricing

**Agencies and freelancers**
- https://www.boldare.com/services/legacy-modernization-with-ai
- https://www.upwork.com/hire/fastapi-developers/ (attempted; 403)
- https://www.toptal.com/developers/flask (attempted; bot challenge)

**Also checked**
- https://codemod.com/pricing
- https://docs.codemod.com/llms.txt
- https://docs.codegen.com/tutorials/flask-to-fastapi (returned Page Not Found)
