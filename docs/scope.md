# What Goose can do today, and what it cannot

Assessment is broader than execution. We inspect any repository we are sent; we only quote work we can carry out and verify.

## Inspect (any repository)
- Languages and size; for Python: framework and version, Python version, pinned packages.
- **Flask** apps using `sqlite3`: routes, the SQL each runs, tables read and written, business rules, data profile.
- **Django** projects: settings, URL patterns, views, models and tables, templates, tests, removed-API uses, settings whose
  defaults change on upgrade, and data patterns such as double bookings.
- Outside connections: clients named in docs or code comments, and scripts that open the database directly.
- Every finding cites a file and line or a value observed in the data.

## Carry out and verify (local mode, deterministic tools)
| Recipe | When it applies | What it changes | How it is verified |
| --- | --- | --- | --- |
| Django 5.2 LTS in place | Django below 5.2 | Pins Django 5.2 and Python 3.13, rewrites removed APIs with `django-upgrade`, keeps settings whose defaults changed (for example `USE_TZ`), records the model change as a migration | Same requests to old and new app on separate copies; every row after the requests and after migrations; the app's own tests; outside scripts re-run; `manage.py check`; no missing migration; clean install; empty-database start |
| Flask current, in place | Flask app | Pins current Flask libraries and Python 3.13, rewrites the few removed imports that have a mechanical replacement | Same requests to old and new app; every row afterwards; the app's own tests; clean install; empty-database start |
| Replace with FastAPI + PostgreSQL | Flask + `sqlite3` JSON API, a copy of the data | Codemod that keeps the owner's SQL and comments, PostgreSQL schema, re-runnable data move | 173 checks on the sample order service: every row and field, money, stock, retries, concurrency, dates, re-running the move, old-versus-new answers |

## SuiteCRM 7 (the sales workflow moves to a new workspace)
| Step | How | Limits |
| --- | --- | --- |
| Run the original | Customer's code without `vendor/` + a `mysqldump`; restored into Goose's own MariaDB 10.3 in a local Linux VM; PHP 7.4 copy started in a container; dependencies rebuilt from `composer.lock` | Tested on SuiteCRM 7.11.23 only; the baseline of stock files and settings is per version |
| Find customizations | Every file checked against SuiteCRM's `files.md5` and a pristine install of the same version; custom fields from `fields_meta_data`; logic hooks, dropdowns and layouts read by PHP in an isolated container (no network) | Custom PHP is read with pattern rules: an approval-style rule is recognised with its parameters and line numbers; any other custom code is reported as needing a person or the agent team, and the job is not quoted |
| Record the original's behaviour | On a disposable copy (recording passwords, never the customer's system): sign-in, what each user lists in 6 modules, opening, editing and deleting sampled records, 13 approval-rule scenarios through SuiteCRM's own API | Delete permission for accounts, contacts, deals and leads is taken from the role settings, not observed |
| Build | Goose's sales-workspace template (FastAPI + PostgreSQL, server-rendered pages) configured from the inspection: stages, dropdowns, the renewal field, the approval rule's parameters, roles and teams | The template covers accounts, contacts, leads, deals, notes, tasks, lead conversion and one approval rule; reports, imports, exports, e-mail, calendar and cases stay in SuiteCRM |
| Move the data | Deterministic, one transaction, ids kept, stored values copied (including SuiteCRM's US-dollar amounts and password hashes) | Contacts with several accounts are reduced to one link (warned; none in the demo data) |
| Verify | Frozen checks: every record, field, relationship, renewal date, note, task and history row; every user's list/view/edit/delete compared with the recording; direct requests that try to skip rules; each approval scenario against the original; lead conversion, including repeats and simultaneous requests; creating and editing after the move | Screens are only checked to load; layout and wording are reviewed by people |
| Switch over | `npm run crm -- cutover JOB`: sales roles in SuiteCRM set read-only (old settings saved), final dump, re-move, data checks re-run | Not zero downtime: sales edits pause for the measured duration. Rollback restores the role settings; work entered in the workspace afterwards is not copied back |

## Needs the live agent team (Naive), not available in local mode
- Code changes no tool can make (bug fixes such as a booking site's double bookings, Flask or Django APIs with no mechanical rewrite).
- Repairs for the in-place recipes (local mode has deterministic repair rules only for the FastAPI recipe).
- The agent-written plan. In local mode the plan comes from the deterministic planner, and the page says so.

## Not supported yet (the plan says so and we do not quote)
- Moving a Django database, or moving a Flask app's database while keeping Flask.
- Other languages and frameworks (we inspect them and report what we found).
- Databases other than SQLite as the source; ORMs other than Django's for data moves.
- Logins, sessions, file uploads and background jobs are inspected but not exercised by the checks.

## Limits of the proof
- Checks compare the requests the scenario sends and every row of data; requests it does not send are not compared.
- Without a copy of the data, checks run on an empty test database; flows that need existing records may not be exercised,
  and the coverage check then blocks delivery.
- macOS sandbox (`sandbox-exec`); operator pages have no login.
- Passing the checks does not prove every possible behaviour is correct.
