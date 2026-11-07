# Goose prospect research: Flask + SQLite apps that need modernising

Researched on 2026-11-04 from public sources. Nobody has been contacted.

**Scope reminder (Goose v1):** take a small, aging Python/Flask + SQLite web app (best fit: a JSON API or small internal tool, raw `sqlite3` or light SQLAlchemy, under about 5k lines and 20 tables), move it to FastAPI + PostgreSQL, migrate the data, prove behaviour with deterministic acceptance checks, and hand over code, migration files, test evidence and a rollback guide for a fixed pilot price. The customer must be able to give us the source code and a copy of the database.

**How to read this:** categories are (a) open-source Flask + SQLite apps, (b) small agencies/consultancies that could be a partner or distribution channel, and (c) organisations that publicly run a Flask + SQLite internal tool. The fit score combines v1 scope fit, strength of the need, realistic access, and whether anyone could pay. Evidence is paraphrased with a link to the exact file, issue or PR. To keep quoting to a minimum, the report contains a single short direct quote (in prospect 1); version pins, file names and error strings are shown as code.

## Summary table

| # | Prospect | Cat. | What it is | Main evidence of need | v1 scope fit | Score | Last activity seen |
|---|---|---|---|---|---|---|---|
| 1 | **Bethel University: Classifieds (and Book Exchange)** | c | Campus classifieds web app run by a private university's web team | Dependencies were pinned to Flask 1.1.4 / Werkzeug 1.0.1 on 2026-10-23 for their OS 8 servers. Dependabot PRs to Flask 3.1.3 and Werkzeug 3.1.9 (both security fix releases) are still open. SQLite DB is backed up by a 6-hourly cron dump. | Very small (about 1.8k Python lines, 4 tables), SQLite + Flask-SQLAlchemy. Server-rendered pages and CAS single sign-on are the main extra work. | **High** | 2026-10-23 |
| 2 | SizeSquirrel | a | Climbing-shoe sizing site: Flask JSON API + Vue front end | Flask 1.1.4, Werkzeug 1.0.1, Flask-Script, README recommends Python 3.8.2. The owner says the site barely covers its costs and asks for contributors. | Near-ideal: JSON API, 5 models, about 4k lines, SQLite in dev (production DB not stated) | Medium | Issue opened 2025-12-23; last commit 2025-08-01 |
| 3 | Isso | a | Self-hosted comment server (Disqus alternative) used by many sites | Request open since 2014 for a SQL layer so MySQL/PostgreSQL can be used. It is labelled needs-contributor / needs-decision, and third-party Postgres and MySQL forks are linked in the thread. | Raw `sqlite3` JSON API of about 4–5k lines, but built on Werkzeug, not Flask. A new AI policy limits agent-made contributions. | Medium | 2026-10-25 |
| 4 | Wavect GmbH | b | Two-founder software agency, Austria | Its own site has a dedicated Flask development services page | Partner channel for client Flask apps; no SQLite need of its own | Medium | Site checked 2026-11-04 |
| 5 | Level 12 | b | Python consultancy, Louisville KY | Its GitHub org maintains Keg, a Flask + SQLAlchemy framework (active 2026), and it blogged in 2025 about AI-assisted library modernisation | Flask-loyal (own framework), so a FastAPI-only offer may clash; could also be a competitor | Low | GitHub org 2026-11-03 |
| 6 | Subscribie | a | Subscription-payments platform and hosted service built on Flask | The lead contributor opened an issue to support MySQL so SQLite stops being a single point of failure. A PR for it has been open since 2022. | Flask + SQLite, but about 13k lines, 148 templates, Stripe, multi-instance hosting | Low | Last commit 2026-07-26; push 2026-10-31 |
| 7 | OpenAlgo | a | Self-hosted algorithmic-trading platform (Flask) by Marketcalls | New open issue (2026-11-03): the scheduler thread dies on SQLite `database is locked`, after several similar issues in Aug 2026 | Flask 3 with several SQLite DBs + DuckDB; over 1,200 Python files, far beyond v1 | Low | 2026-11-03 |
| 8 | MakeIt Labs `authbackend` | c | Membership, billing and RFID-access backend of a 501(c)(3) makerspace (Nashua, NH) | Production Flask + SQLite app pinned to 2022-era packages (Flask 2.0.2, Werkzeug 2.0.2, unmaintained Flask-User) | About 18k lines, 84 templates, Stripe/Slack/MQTT/Google integrations | Low | 2024-01-26 |

**Count by category:** (a) 4 prospects (2, 3, 6, 7) · (b) 2 prospects (4, 5) · (c) 2 prospects (1, 8). Total 8. More candidates that were checked and left out are listed under [Also considered](#also-considered-not-scored).

---

## 1. Bethel University: Classifieds (and Book Exchange), category (c)

- **URLs:** https://github.com/betheluniversity/classifieds · org: https://github.com/betheluniversity · about: https://www.bethel.edu/about/
- **What it is:** Bethel University's own classifieds site. Anyone with a Bethel account can browse ads, contact sellers and post items. Admins manage categories, moderate posts, add contacts who have no Bethel account, and grant or remove admin rights. Posts expire after 30 days. The README says the same code also runs BU's Book Exchange ([README](https://github.com/betheluniversity/classifieds/blob/master/README.md)). Bethel describes itself as a private Christian university in St. Paul, MN with 4,000+ students ([about page](https://www.bethel.edu/about/)).
- **Who maintains it:** Bethel's in-house web/ITS developers, through the official `betheluniversity` GitHub organisation (its profile links to bethel.edu). The repo has 8 contributors. The same org has other Flask apps with similar old pins, for example [tinker](https://github.com/betheluniversity/tinker) (Flask-SQLAlchemy 2.1, Flask-Script, sqlalchemy-migrate, active 2026-10-29) and [programs](https://github.com/betheluniversity/programs) (Flask 1.0.4, Werkzeug 0.15.3).
- **Evidence of need:**
  - [PR #58](https://github.com/betheluniversity/classifieds/pull/58), merged 2026-10-23, pinned the stack. Its description reads "Pin dependencies for running on OS 8." The resulting [requirements.txt](https://github.com/betheluniversity/classifieds/blob/master/requirements.txt) has `Flask==1.1.4`, `Werkzeug==1.0.1`, `Jinja2==2.11.3`, `click==7.1.2`, `itsdangerous==1.1.0`, plus unpinned `Flask-Classy` and `Flask-Script`.
  - Within two hours Dependabot opened [#59](https://github.com/betheluniversity/classifieds/pull/59) (Flask 1.1.4 → 3.1.3), [#60](https://github.com/betheluniversity/classifieds/pull/60) (Jinja2 2.11.3 → 3.1.6) and [#61](https://github.com/betheluniversity/classifieds/pull/61) (Werkzeug 1.0.1 → 3.1.9). The Flask 3.1.3 and Werkzeug 3.1.9 release notes call them security fix releases, and all three PRs were still open on 2026-11-04. A 2023 Dependabot PR ([#57](https://github.com/betheluniversity/classifieds/pull/57), Werkzeug → 2.2.3) was closed unmerged the same day.
  - These bumps can't simply be merged. Flask-Script is archived and imports `flask._compat`, which was removed in Flask 2.0 ([source](https://github.com/smurfix/flask-script/blob/master/flask_script/__init__.py)). Flask-Classy's source calls `inspect.getargspec`, which was removed in Python 3.11 ([source](https://github.com/apiguy/flask-classy/blob/master/flask_classy.py)).
  - SQLite in production: [config.py.dist](https://github.com/betheluniversity/classifieds/blob/master/config.py.dist) points `SQLALCHEMY_DATABASE_URI` at `app.db`. [rotate_db_file.sh](https://github.com/betheluniversity/classifieds/blob/master/rotate_db_file.sh) runs a `sqlite3 .dump` every 6 hours by cron, keeps 13 days, and names both the classifieds and book_exchange directories.
  - There are no automated tests in the repo.
- **Fit with v1 scope:**
  - *UI/API:* server-rendered (24 Jinja templates, about 1.2k lines) with a small JSON endpoint or two. This is an internal tool, not a pure JSON API.
  - *Database:* Flask-SQLAlchemy ORM with no raw `sqlite3` in app code. 4 tables ([models.py](https://github.com/betheluniversity/classifieds/blob/master/app/models.py)): posts, contacts, categories, post_categories.
  - *Auth:* Apache `mod_auth_cas` sets `REMOTE_USER`. On first login the app looks the user up at an internal Bethel web service. The admin flag is stored in the DB ([app/__init__.py](https://github.com/betheluniversity/classifieds/blob/master/app/__init__.py)).
  - *Jobs:* a nightly cron calls the `expire` handler, and email goes out through `smtplib` ([views.py](https://github.com/betheluniversity/classifieds/blob/master/app/views.py), [controller.py](https://github.com/betheluniversity/classifieds/blob/master/app/controller.py)).
  - *Size:* about 1,780 Python lines (including a 220-line one-off transfer script) and about 36 view handlers in one class-based view.
- **Likely blockers:** server-rendered templates that use Flask-Classy endpoint names; the CAS hand-off through Apache/mod_wsgi; the team may want to stay on Flask 3 rather than move to FastAPI; the DB holds names, emails and phone numbers, so a sanitized copy or on-site migration may be needed; university procurement; PostgreSQL may not be their standard (other Bethel apps use Oracle or MySQL).
- **Access path and public contact channel:** the code is already public, so a full pre-assessment needs no access. For the pilot we would need the two SQLite files, or their cron dumps, from Bethel's team. Public channel: Bethel ITS service portal (https://bethel.topdesk.net, listed on https://www.bethel.edu/its/apps, which also gives a general help-desk email). Ask for the request to go to the web applications team. GitHub issues are enabled on the repo but are not a suitable sales channel.
- **Fit score: High.** It is a tiny SQLite app with fresh, visible upgrade pressure, an institutional owner with a budget, and a portfolio of similar apps. The main risks are the server-rendered UI, CAS, and whether they accept FastAPI.
- **Last activity observed:** 2026-10-23 (PR #58 merged, Dependabot PRs opened). Default-branch HEAD is `41c0735` (2026-10-23).

## 2. SizeSquirrel, category (a)

- **URLs:** https://github.com/eddieferrer/sizesquirrel-open · site: https://sizesquirrel.com
- **What it is:** a public climbing-shoe sizing, recommendation and deals site with a Flask JSON API backend and a Vue front end ([README](https://github.com/eddieferrer/sizesquirrel-open/blob/master/README.md)).
- **Who maintains it:** a single owner-maintainer (GitHub `eddieferrer`). The README says the site barely pays its running costs, that no new features are planned, and that contributors are welcome through GitHub issues.
- **Evidence of need:**
  - [requirements.txt](https://github.com/eddieferrer/sizesquirrel-open/blob/master/requirements.txt) pins `Flask==1.1.4`, `Werkzeug==1.0.1`, `Jinja2==2.11.3`, `SQLAlchemy==1.4.25`, `Flask-SQLAlchemy==2.5.1`, `Flask-Script==2.0.6` (archived, and incompatible with Flask 2+) and `gunicorn==20.1.0`.
  - The README recommends Python 3.8.2 (end-of-life) and Node 14.16 (end-of-life).
  - [manage.py](https://github.com/eddieferrer/sizesquirrel-open/blob/master/manage.py) runs the commands through Flask-Script.
  - There are no automated tests.
- **Fit with v1 scope:**
  - *UI/API:* a JSON API under `/apiv2/...` ([views.py](https://github.com/eddieferrer/sizesquirrel-open/blob/master/backend/apiv2/views.py), 21 `jsonify` returns). The Vue SPA would stay unchanged.
  - *Database:* Flask-SQLAlchemy with 5 models: user, gender, brand, item, user_item ([models.py](https://github.com/eddieferrer/sizesquirrel-open/blob/master/backend/models.py)). SQLite in development ([dev_settings.py](https://github.com/eddieferrer/sizesquirrel-open/blob/master/dev_settings.py)); the production engine is not stated.
  - *Auth:* own user accounts (Flask-HTTPAuth and passlib in requirements).
  - *Jobs:* batch commands for affiliate data feeds and stats.
  - *Size:* about 4k Python lines, excluding about 100 data-only Alembic migrations.
- **Likely blockers:** little budget (the owner's own words); the production DB might not be SQLite; the shoe catalogue lives in Alembic data migrations, so migration history must be preserved; cron/batch scripts need re-homing off Flask-Script.
- **Access path and contact:** everything needed for a public sample assessment is public, including a committed sample dev database (`sample_dev-database.db`) and a script that scrubs personal data for dev copies. We did not open the database. Contact through GitHub issues on the repo, which the README invites.
- **Fit score: Medium.** It is technically the cleanest v1 match and fully public, which makes it the best free public sample, but a paid pilot is unlikely.
- **Last activity observed:** last commit 2025-08-01 (`d2b7b27`); newest issue [#815](https://github.com/eddieferrer/sizesquirrel-open/issues/815) opened 2025-12-23.

## 3. Isso, category (a)

- **URLs:** https://github.com/isso-comments/isso · docs: https://isso-comments.de
- **What it is:** a lightweight self-hosted commenting server (Disqus alternative) with a JSON API and a JS client embedded in many blogs and sites. It has 5.3k stars.
- **Who maintains it:** the `isso-comments` GitHub organisation, which has active maintainers merging community PRs in 2026. Release 0.14.0 came out on 2026-03-26.
- **Evidence of need:**
  - [Issue #61](https://github.com/isso-comments/isso/issues/61), opened in 2014 by the original author, asks for a SQL abstraction layer so MySQL and PostgreSQL can be used. It is still open with labels `needs-contributor` and `needs-decision`. In 2022 a maintainer collected links to third-party PostgreSQL and MySQL forks in the thread, and users were still commenting in 2024.
  - The DB layer is hand-written SQL on raw `sqlite3` ([isso/db/\_\_init\_\_.py](https://github.com/isso-comments/isso/blob/master/isso/db/__init__.py), plus comments/threads/preferences/spam modules).
- **Fit with v1 scope:**
  - *API:* JSON REST API, which is good.
  - *Database:* raw `sqlite3` with about 4 tables, which is good.
  - *Size:* about 4–5k Python lines plus tests, which is good.
  - *Framework:* **Werkzeug, not Flask** ([isso/\_\_init\_\_.py](https://github.com/isso-comments/isso/blob/master/isso/__init__.py) imports Werkzeug routing and middleware; [pyproject.toml](https://github.com/isso-comments/isso/blob/master/pyproject.toml) needs `werkzeug>=1.0`, Python ≥3.10).
  - *Jobs:* email/webhook notifications.
- **Likely blockers:** upstream would want an optional PostgreSQL backend, not a FastAPI rewrite. There is no built-in payer: a paid job would come from a site operator, who would then run a fork. The project added an AI policy on 2026-10-25 ([PR #1134](https://github.com/isso-comments/isso/pull/1134), [contributing docs](https://github.com/isso-comments/isso/blob/master/docs/docs/contributing/index.rst)): every contribution must be backed by a human copyright owner, and unsupervised agentic tools are banned. Any upstream work by Goose would need a named human owner.
- **Access path and contact:** public code. GitHub Discussions (https://github.com/isso-comments/isso/discussions) and IRC `#isso` on Libera.Chat, both listed in the README.
- **Fit score: Medium.** It is the right size, uses raw `sqlite3` and has a decade-old Postgres request, which makes it a strong public sample-assessment subject. As a paid v1 pilot it is weak (not Flask, no payer, AI policy).
- **Last activity observed:** 2026-10-25 (`9f38df7`).

## 4. Wavect GmbH, category (b)

- **URLs:** Flask page https://wavect.io/services/flask-development · contact https://wavect.io/contact/
- **What it is:** an Austrian custom-software agency (Ampass, Tyrol, plus Vienna). Its homepage describes two founders working with a network of specialists.
- **Evidence of Flask work (primary source):** the agency's own Flask services page covers building focused Flask services, making existing Flask services easier to run and change, checking extension compatibility, and testing API behaviour. It links a client case study whose rebuild stack includes Flask.
- **Fit with v1 scope:** a partner or subcontracting channel. They could pass along client Flask + SQLite apps that need a fixed-scope FastAPI + PostgreSQL upgrade, with Goose delivering the mechanical part and its test evidence. Neither the page nor its case studies mention SQLite.
- **Likely blockers:** a small agency may prefer to keep upgrade work in-house; its Flask page is about keeping Flask, not leaving it; no evidence that its clients run SQLite.
- **Access path and contact:** the contact page above (the site also offers a call-booking link). Client code and DBs would come to us under the agency's client agreements.
- **Fit score: Medium.** It has explicit Flask service work and is small enough to value a subcontractor, but its demand for this specific job is unproven.
- **Last activity observed:** website live and checked 2026-11-04 (no dated post checked).

## 5. Level 12, category (b)

- **URLs:** https://www.level12.io/ · contact https://www.level12.io/contact/ · GitHub org https://github.com/level12 (profile links to level12.io)
- **What it is:** a custom software consultancy based in Louisville, KY. Its homepage describes the team as Python developers first and says it has been building software since 2011.
- **Evidence of Flask work:** its official GitHub organisation maintains [Keg](https://github.com/level12/keg), an opinionated framework built on Flask and SQLAlchemy (pushed 2026-09-02), plus keg-auth, keg-storage and flask-hypergen (pushed 2026-11-03). Caveat: the level12.io homepage and blog index do not mention Flask (checked), so the primary source for Flask work is the company's own GitHub org rather than its website. Its blog has a [2025-04-25 post](https://www.level12.io/blog/ai-driven-library-updates-modernizing-morphi-augment-code/) on AI-assisted updating of a Python library.
- **Fit with v1 scope:** possible referral partner for clients who want to leave Flask, or a subcontract for data migration and test evidence.
- **Likely blockers:** their identity is built on Flask (Keg), so a FastAPI-only offer competes with their own framework. They already use AI tools for modernisation, so they may see Goose as a competitor. We don't know if their client apps use SQLite.
- **Access path and contact:** the contact page above (it offers scheduling links).
- **Fit score: Low.** It is a credible Flask shop, but its strategy points the other way.
- **Last activity observed:** GitHub org activity 2026-11-03.

## 6. Subscribie, category (a)

- **URLs:** https://github.com/Subscribie/subscribie · hosted service https://subscribie.co.uk
- **What it is:** an open-source platform and hosted service that lets small businesses collect recurring payments.
- **Who maintains it:** the Subscribie GitHub org. The lead contributor has about 2,100 commits.
- **Evidence of need:**
  - [Issue #738](https://github.com/Subscribie/subscribie/issues/738), opened by the lead contributor in 2021 and still open, asks for migrations to work on MySQL as groundwork for higher-availability databases that remove a single point of failure.
  - The matching [PR #898](https://github.com/Subscribie/subscribie/pull/898) has been open since 2022 and was last updated 2023-03-30.
  - The default config uses SQLite ([settings.yaml.example](https://github.com/Subscribie/subscribie/blob/master/settings.yaml.example)).
- **Fit with v1 scope:**
  - *UI:* server-rendered (148 HTML templates).
  - *Database:* Flask-SQLAlchemy + Alembic.
  - *Payments:* Stripe.
  - *Hosting:* uWSGI emperor/vassal files suggest one instance per shop.
  - *Size:* about 13k Python lines.
  - Modern Python (≥3.12, per pyproject).
- **Likely blockers:** size and template count are well above v1; the maintainer's target is MySQL, not PostgreSQL; they would probably want to stay on Flask; payment flows raise the risk.
- **Access path and contact:** public code; GitHub issues. The hosted-service site mentions email/chat support but has no contact page.
- **Fit score: Low (for v1).** The need is real and the owner says so, but the app is too large. Worth revisiting for a later database-only offering.
- **Last activity observed:** last default-branch commit 2026-07-26 (`2070227`); repo push 2026-10-31.

## 7. OpenAlgo, category (a)

- **URLs:** https://github.com/marketcalls/openalgo · docs https://docs.openalgo.in
- **What it is:** a self-hosted algorithmic-trading platform with 36 broker plugins, used by retail traders. Maintained by Marketcalls (GitHub `marketcalls`, Bangalore).
- **Evidence of need:**
  - [Issue #2355](https://github.com/marketcalls/openalgo/issues/2355), opened 2026-11-03, reports that the APScheduler thread crashes on `sqlite3.OperationalError: database is locked` with the default SQLite DB, and all scheduled flows stop until a restart.
  - Similar reports were closed in Aug 2026: [#1738](https://github.com/marketcalls/openalgo/issues/1738), [#1759](https://github.com/marketcalls/openalgo/issues/1759), and the fix PR [#1734](https://github.com/marketcalls/openalgo/pull/1734).
  - [.sample.env](https://github.com/marketcalls/openalgo/blob/main/.sample.env) defines five separate SQLite databases plus DuckDB.
- **Fit with v1 scope:**
  - *Stack:* Flask 3.1.3, Flask-RESTX API, Socket.IO, APScheduler, SQLAlchemy.
  - *Size:* over 1,200 Python files outside tests, far beyond v1.
- **Likely blockers:** size, real-money trading risk, and many self-hosted installs with separate databases. They would want PostgreSQL support added, not a FastAPI move.
- **Access path and contact:** public code; GitHub issues and the Discord linked in the README.
- **Fit score: Low.** It shows the clearest current SQLite-locking pain, but the scope is wrong for v1.
- **Last activity observed:** 2026-11-03 (`e2797fd`, plus issue #2355).

## 8. MakeIt Labs `authbackend`, category (c)

- **URLs:** https://github.com/makeitlabs/authbackend · org site https://makeitlabs.com (contact page https://makeitlabs.com/contact) · nonprofit status https://www.charitynavigator.org/ein/452258590
- **What it is:** the membership and authorisation backend of MakeIt Labs, a makerspace in Nashua, NH listed as a 501(c)(3) on Charity Navigator. The repo describes a web interface, an API, Stripe billing, and support for its door and tool access-control devices.
- **Evidence of need:**
  - Production use on SQLite: two commits on 2022-12-29 record the Python 3 version 2.0 and its move to production. The [README](https://github.com/makeitlabs/authbackend/blob/master/README.md) explains restoring `db.sq3` and log DBs from S3 backups.
  - [requirements.txt](https://github.com/makeitlabs/authbackend/blob/master/requirements.txt) pins 2022-era versions (`Flask==2.0.2`, `Werkzeug==2.0.2`, `Flask-User==1.0.2.2`, `SQLAlchemy==1.4.31`, `oauth2client`, `slacker`). The README calls its own docs rough as of April 2022.
- **Fit with v1 scope:**
  - *UI/API:* server-rendered (84 templates) plus API.
  - *Database:* mixed raw `sqlite3` ([schema.sql](https://github.com/makeitlabs/authbackend/blob/master/schema.sql), many modules) and Flask-SQLAlchemy.
  - *Jobs:* MQTT daemon, Slack integration, nightly jobs, S3 backups.
  - *Size:* about 18k Python lines, with some tests.
- **Likely blockers:** size and number of integrations; door-access hardware depends on it; member PII; volunteer-run, so the budget is likely small; no repo activity since early 2024.
- **Access path and contact:** public code. The org's contact page, or GitHub issues (the latest, [#49](https://github.com/makeitlabs/authbackend/issues/49), is from 2024-01-26).
- **Fit score: Low.** A genuine nonprofit running Flask + SQLite in production with aging pins, but too big and too integrated for v1.
- **Last activity observed:** 2024-01-26. The last default-branch commit is 2022-12-29 (`08af0cb`).

---

## Best prospect: Bethel University Classifieds

**Why this one:**
- The need is current and visible: they pinned old packages for their OS 8 servers 12 days ago, and the security updates sit unmerged.
- The app is as small as a pilot can be: about 1.8k lines and 4 tables, on SQLite and Flask-SQLAlchemy.
- The owner is an institution with an in-house team, so a fixed-price pilot is a plausible purchase.
- The same code runs a second site (Book Exchange), and the same team has several other aging Flask apps. One good pilot could lead to repeat work.

SizeSquirrel is the better pure technical match, but the owner has said the site barely covers its costs, so it is better used as a free public sample.

### Sample pre-assessment

> **Based on public code only; not reviewed by the maintainer.** Snapshot: `betheluniversity/classifieds` at `41c0735` (master, 2026-10-23). We read the code through GitHub. We did not run it and did not access any database. Line counts are exact `wc -l` of the public files.

**1. What we would upgrade**

| Area | Today (observed) | After the pilot |
|---|---|---|
| Runtime | Python version not pinned in repo. The OS 8 pins suggest an older interpreter (not verified). | A currently supported Python available on their servers |
| Web framework | Flask 1.1.4, Werkzeug 1.0.1, Jinja2 2.11.3, Flask-Classy (one class with about 36 handlers) | FastAPI with the same URLs. Existing Jinja templates are served through FastAPI's Jinja2 support. |
| CLI | Flask-Script (archived, breaks on Flask ≥2.0) | Plain CLI entry points |
| ORM / migrations | Flask-SQLAlchemy (unpinned), SQLAlchemy ≥1.3. Two migration histories: sqlalchemy-migrate (`db_repository/`) and Alembic (`migrations/`, 2016). | SQLAlchemy 2.x, one Alembic chain baselined from the real production schema |
| Database | SQLite `app.db` for Classifieds plus a second DB for Book Exchange; 6-hourly `.dump` cron | PostgreSQL, with data-migration scripts for both DBs and row-count/checksum reports |
| Auth | Apache `mod_auth_cas` puts the user in `REMOTE_USER`; first-login lookup to an internal Bethel web service | Same CAS at Apache. The username is passed to the app in an agreed, trusted way. |
| Jobs / email | Nightly cron calls the `expire` handler; `smtplib` emails | Same endpoint and behaviour; email tested against a local sink |
| Tests | None | Characterization tests and acceptance checks that stay with Bethel |

**2. In scope (v1)**
- All handlers and the 4 tables (posts, contacts, categories, post_categories), for both deployments.
- Templates kept as they are, with small compatibility helpers. They contain 83 `url_for` calls using Flask-Classy endpoint names and 9 reads of `session`.
- Data migration for both SQLite files.
- Deterministic acceptance checks: route-by-route HTTP comparison between the current app on SQLite and the new app on PostgreSQL, using the existing test-user mode and fixed seed data, plus DB parity checks (row counts, checksums, sequences).
- Rollback guide: keep the old app and SQLite files read-only and switch the Apache config back. A write-freeze window during cutover avoids having to reconcile writes.

**3. Out of scope (unless agreed separately)**
- Changes to Bethel's Apache/CAS servers. We document what's needed; their team applies it.
- Provisioning or hosting PostgreSQL.
- UI redesign or new features.
- Changes to the internal name-lookup service.
- Porting the one-off `transfer_db.py` and the retired sqlalchemy-migrate repo.
- Security fixes beyond like-for-like. These would be listed as findings, not changed.

**4. Risks found in the public code (each becomes an acceptance check)**
1. **Queries that work on SQLite but fail on PostgreSQL.** Integer IDs are matched with `LIKE` (for example `Posts.id.like(post_id)`), and search applies a wildcard `LIKE '%'` to boolean columns (`completed`, `expired`) ([controller.py](https://github.com/betheluniversity/classifieds/blob/master/app/controller.py)). PostgreSQL has no `LIKE` for integers or booleans. These need equality or always-true filters.
2. **Case sensitivity changes.** SQLite's `LIKE` ignores ASCII case, while PostgreSQL's does not. Title/description search and username lookups would silently start missing matches unless we use `ILIKE` or `lower()`.
3. **Length limits start being enforced.** SQLite ignores `VARCHAR(n)`; PostgreSQL enforces it (for example `first_name` 20, `title` 100, `description` 1000 ([migration](https://github.com/betheluniversity/classifieds/blob/master/migrations/versions/31d8495be9b6_.py))). Existing rows need profiling, and we need a decision to widen or keep the limits, because new long inputs would start failing.
4. **Foreign keys.** SQLite does not enforce them unless switched on. Orphaned posts or post-category rows would break a PostgreSQL import, so we need an agreed clean-up rule.
5. **IDs and sequences.** Sequences must be reset after the copy. New-post code reads the highest ID after insert; this should use the inserted row's ID to avoid races under a multi-worker server.
6. **Value types.** SQLite booleans (0/1) and text timestamps need explicit casts. Naive local timestamps should be kept so the 30-day expiry behaves the same.
7. **Two migration histories.** The production schema has to be read from the real database, not inferred from either history.
8. **No tests today.** Characterization tests must be written first, before any change.
9. **Auth hand-off.** `REMOTE_USER` from mod_wsgi does not reach an ASGI app the same way. This needs a trusted proxy header or an adapter, agreed with their server team.
10. **Pre-existing issues to report but not change unless asked:** forms carry no CSRF token; a bare `except` hides user-initialisation failures; an HTTP response is parsed with `ast.literal_eval`.
11. **Framework preference.** Bethel's apps share a Flask house style (Flask-Classy, a Flask template repo). The team may prefer Flask 3 over FastAPI, and Goose only delivers FastAPI today, so this has to be raised up front.

**5. What we would need from Bethel**
- The deployed commit and configuration for Classifieds and Book Exchange, with secrets removed.
- A copy of each SQLite database, or the latest cron dump. Because it holds names, emails and phone numbers, either a sanitized copy (we can supply a script) or running our migration inside Bethel's environment. A data agreement if required.
- Target PostgreSQL version and host, and the Python versions available on their OS 8 servers.
- How CAS and Apache are configured, and how cron calls the `expire` handler.
- A test login (the code already has a test-user mode for non-production) and an SMTP sink.
- One named reviewer to approve the acceptance-check list and sign off the cutover.

### Outreach draft

> **DRAFT — NOT SENT.** Suggested channel: Bethel ITS service portal (bethel.topdesk.net), asking for it to be routed to the web applications team. Word count: 145 words in the body plus a 7-word subject line (152 in total, under the 160 limit).

**Subject:** Fixed-price pilot to upgrade your Classifieds app

Hello,

I'm [NAME] from Goose, a new company that upgrades small Python web apps. AI agents do the work, and repeatable tests check it.

I read your public Classifieds repository and saw that its packages were recently pinned to Flask 1.1.4 for your OS 8 servers, while the Flask 3 and Werkzeug 3 security updates are still open.

We offer a fixed-price pilot for [PILOT PRICE]: we move Classifieds (and Book Exchange, which shares the code) to FastAPI and PostgreSQL, migrate the data, and show with tests that every page still works. You get the code, migration files, test results and a rollback guide.

We would need the source and a copy of each database; a cleaned copy is fine. I can also share a free assessment of your public code.

Would a 20-minute call help? If not, I will not write again.

Thanks,
[NAME]

---

## Also considered (not scored)

| Candidate | Why not on the list |
|---|---|
| [Arch Linux Security Tracker](https://github.com/archlinux/arch-security-tracker) | Flask + SQLite (`tracker.db`) with `SQLAlchemy<2.0` forced and an open Flask-SQLAlchemy 3 issue ([#219](https://github.com/archlinux/arch-security-tracker/issues/219)). About 5.6k lines with tests. Volunteer-run with no payer, and they would want to stay on Flask. A good public-sample subject. |
| [Deep Learning Indaba: Baobab](https://github.com/deep-learning-indaba/Baobab) | Very old pins (`Flask==1.1.2`, `Werkzeug==0.16.1`, Flask-Script in [api/requirements.txt](https://github.com/deep-learning-indaba/Baobab/blob/develop/api/requirements.txt)) and active in Oct 2026. But it is already on PostgreSQL and has about 60k backend lines, so it would need a framework-only offer. |
| [Wikimedia Quarry](https://github.com/toolforge/quarry) | `flask==1.1.4`, `werkzeug==0.16.0`, active in Nov 2026. But it uses MySQL + Celery, with SQLite only for query-result files. Volunteer/WMF-run. |
| [Mycodo](https://github.com/kizniche/Mycodo) | DB-lock issue [#1310](https://github.com/kizniche/Mycodo/issues/1310) is still open, but the last comment was in 2023 and the app is now on Flask 3.1.2. Large hardware-control app. |
| [Gramps Web API](https://github.com/gramps-project/gramps-web-api) | Recent SQLite lock bugs (e.g. [#1115](https://github.com/gramps-project/gramps-web-api/issues/1115)) were fixed in Oct 2026, and it already supports PostgreSQL. |
| [WGDashboard](https://github.com/donaldzou/WGDashboard), [PowerDNS-Admin](https://github.com/PowerDNS-Admin/PowerDNS-Admin) | Already on Flask 3 with PostgreSQL/MySQL drivers. |
| [Temboz](https://github.com/fazalmajid/temboz) | Flask + raw `sqlite3`, with a Postgres request open since 2013 ([#44](https://github.com/fazalmajid/temboz/issues/44)). It is a personal single-user reader with no organisational user. |
| [Tautulli](https://github.com/Tautulli/Tautulli) | Raw `sqlite3` and an open PostgreSQL request ([#1556](https://github.com/Tautulli/Tautulli/issues/1556), 2026-02). But it uses CherryPy, not Flask, and is large. |
| [ShyneBeauty](https://github.com/BrandonRobare/ShyneBeauty) | Flask + SQLite internal-operations app for a small skincare business (Kent State capstone, spring 2026). It is modern (Flask 3, SQLAlchemy 2) and well tested, so there is no current modernisation need. |
| [SecureDrop](https://github.com/freedomofpress/securedrop) | Has an open issue to move to Flask 3.0 ([#6963](https://github.com/freedomofpress/securedrop/issues/6963)), but it is a security-critical appliance whose databases cannot be shared. |
| [Simple Thread](https://www.simplethread.com/a-roadmap-to-modernization/) | Published a 2024 plan for rewriting a client's Python 2.7 Flask app. The homepage now focuses on power-system planning software, so partner fit is weak. |
| [Protospace `ldapserver`](https://github.com/Protospace/spaceport/tree/master/ldapserver) | Makerspace service pinned to `Flask==1.1.1` / `Werkzeug==0.16.1`, but it has no database. |
| Teamarr, Grimoire | Have SQLite lock / external-DB requests, but are already FastAPI. |

## Method and limitations

- **GitHub searches:** read-only searches via the authenticated `gh` CLI and GitHub API:
  - issue-title searches in Python repos (PostgreSQL support, `database is locked`, external database, Flask/Werkzeug upgrades);
  - repository searches (flask + sqlite, org-owned makerspace/nonprofit tools);
  - code searches for old pins (`Flask==1.0.2`–`2.1.2`, `Werkzeug==1.0.1`/`2.0.3`, `Flask-Classy`, `Flask-Script`, `SQLALCHEMY_MIGRATE_REPO`).
- **Web:** web search, plus page fetches for agencies and organisations.
- **What we did not do:** no repos were cloned, starred or forked. No issues or PRs were opened, nothing was submitted, nobody was contacted, and no database files were downloaded or opened.
- **Not verified:** SizeSquirrel's production DB engine; Bethel's Python version and the location of the Book Exchange deployment; whether Level 12's or Wavect's clients run SQLite; whether MakeIt Labs still runs this exact version.
- **Line counts:** estimated from file sizes at about 35 bytes per line, except Bethel's, which were counted exactly.
- **Context:** many popular Flask + SQLite projects had already upgraded by late 2026, so the strongest signals now come from smaller, less-maintained or institutional repos.

## Sources

**Bethel University**
- https://github.com/betheluniversity/classifieds
- https://github.com/betheluniversity/classifieds/blob/master/README.md
- https://github.com/betheluniversity/classifieds/blob/master/requirements.txt
- https://github.com/betheluniversity/classifieds/pull/58
- https://github.com/betheluniversity/classifieds/pull/59
- https://github.com/betheluniversity/classifieds/pull/60
- https://github.com/betheluniversity/classifieds/pull/61
- https://github.com/betheluniversity/classifieds/pull/57
- https://github.com/betheluniversity/classifieds/blob/master/config.py.dist
- https://github.com/betheluniversity/classifieds/blob/master/rotate_db_file.sh
- https://github.com/betheluniversity/classifieds/blob/master/app/__init__.py
- https://github.com/betheluniversity/classifieds/blob/master/app/models.py
- https://github.com/betheluniversity/classifieds/blob/master/app/controller.py
- https://github.com/betheluniversity/classifieds/blob/master/app/views.py
- https://github.com/betheluniversity/classifieds/blob/master/migrations/versions/31d8495be9b6_.py
- https://github.com/betheluniversity
- https://github.com/betheluniversity/tinker
- https://github.com/betheluniversity/programs
- https://www.bethel.edu/about/
- https://www.bethel.edu/its/apps

**Flask-Classy and Flask-Script compatibility**
- https://github.com/apiguy/flask-classy/blob/master/flask_classy.py
- https://github.com/smurfix/flask-script/blob/master/flask_script/__init__.py

**SizeSquirrel**
- https://github.com/eddieferrer/sizesquirrel-open
- https://github.com/eddieferrer/sizesquirrel-open/blob/master/README.md
- https://github.com/eddieferrer/sizesquirrel-open/blob/master/requirements.txt
- https://github.com/eddieferrer/sizesquirrel-open/blob/master/dev_settings.py
- https://github.com/eddieferrer/sizesquirrel-open/blob/master/manage.py
- https://github.com/eddieferrer/sizesquirrel-open/blob/master/backend/apiv2/views.py
- https://github.com/eddieferrer/sizesquirrel-open/blob/master/backend/models.py
- https://github.com/eddieferrer/sizesquirrel-open/issues/815
- https://sizesquirrel.com

**Isso**
- https://github.com/isso-comments/isso
- https://github.com/isso-comments/isso/issues/61
- https://github.com/isso-comments/isso/blob/master/isso/db/__init__.py
- https://github.com/isso-comments/isso/blob/master/isso/__init__.py
- https://github.com/isso-comments/isso/blob/master/pyproject.toml
- https://github.com/isso-comments/isso/pull/1134
- https://github.com/isso-comments/isso/blob/master/docs/docs/contributing/index.rst
- https://github.com/isso-comments/isso/discussions

**Wavect**
- https://wavect.io/services/flask-development
- https://wavect.io/
- https://wavect.io/contact/

**Level 12**
- https://www.level12.io/
- https://www.level12.io/blog/
- https://www.level12.io/blog/ai-driven-library-updates-modernizing-morphi-augment-code/
- https://www.level12.io/contact/
- https://github.com/level12
- https://github.com/level12/keg

**Subscribie**
- https://github.com/Subscribie/subscribie
- https://github.com/Subscribie/subscribie/issues/738
- https://github.com/Subscribie/subscribie/pull/898
- https://github.com/Subscribie/subscribie/blob/master/settings.yaml.example
- https://subscribie.co.uk

**OpenAlgo**
- https://github.com/marketcalls/openalgo
- https://github.com/marketcalls/openalgo/issues/2355
- https://github.com/marketcalls/openalgo/issues/1738
- https://github.com/marketcalls/openalgo/issues/1759
- https://github.com/marketcalls/openalgo/pull/1734
- https://github.com/marketcalls/openalgo/blob/main/.sample.env
- https://docs.openalgo.in

**MakeIt Labs**
- https://github.com/makeitlabs/authbackend
- https://github.com/makeitlabs/authbackend/blob/master/README.md
- https://github.com/makeitlabs/authbackend/blob/master/requirements.txt
- https://github.com/makeitlabs/authbackend/blob/master/schema.sql
- https://github.com/makeitlabs/authbackend/issues/49
- https://makeitlabs.com
- https://www.charitynavigator.org/ein/452258590

**Also considered**
- https://github.com/archlinux/arch-security-tracker
- https://github.com/archlinux/arch-security-tracker/issues/219
- https://github.com/deep-learning-indaba/Baobab
- https://github.com/deep-learning-indaba/Baobab/blob/develop/api/requirements.txt
- https://github.com/toolforge/quarry
- https://github.com/kizniche/Mycodo/issues/1310
- https://github.com/gramps-project/gramps-web-api/issues/1115
- https://github.com/donaldzou/WGDashboard
- https://github.com/PowerDNS-Admin/PowerDNS-Admin
- https://github.com/fazalmajid/temboz/issues/44
- https://github.com/Tautulli/Tautulli/issues/1556
- https://github.com/BrandonRobare/ShyneBeauty
- https://github.com/freedomofpress/securedrop/issues/6963
- https://www.simplethread.com/a-roadmap-to-modernization/
- https://www.simplethread.com/
- https://github.com/Protospace/spaceport/tree/master/ldapserver

## The offer we can actually make (updated 2026-11-04)

Nothing has been sent. These are prepared, reviewable drafts; sending any of them needs the founder.

**Offer: "Free inspection and plan, then a fixed-price upgrade you pay for only when the checks pass."**
- We read your repository and send back the application map, the findings with file and line, the options we considered and the
  one we recommend, with what it keeps and what it would cost. No access to your live systems, and no data unless the plan needs it.
- What we can carry out and prove today:
  - Django below 5.2 to 5.2 LTS, keeping the database and integrations ($900 pilot price);
  - Flask apps to current releases on Python 3.13 ($900);
  - Flask + `sqlite3` JSON services replaced with FastAPI on PostgreSQL, data moved and checked row by row ($1,500).

**Fit of the researched prospects against that offer (from the engine's inspection of their public code):**
- **Bethel University Classifieds** and **SizeSquirrel** use Flask-SQLAlchemy and server-rendered pages. The free inspection and plan
  apply today. Execution does not yet, because the in-place Flask recipe's checks cannot yet exercise their form-based pages. The plan
  would say so, and we would not quote. That makes them the best candidates for the next recipe, not for a paid job this week.
- The other six were researched as Flask maintainers and agencies; none has been inspected by the new pipeline yet. The first step for
  each is the free inspection.

**Draft message (for a maintainer, to be reviewed before anything is sent):**
> Hi - we build Goose, which plans and delivers upgrades for small Python web apps. We read the public code of {project} and
> made a short plan: what is out of date, what we would change, what we would keep, and how we would prove nothing your users rely
> on changes. It's free and yours to keep, whether or not you want us to do the work. Would it help if I sent it over?
