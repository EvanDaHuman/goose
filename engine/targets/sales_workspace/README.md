# Sales workspace (Goose template)

The workspace Goose delivers when a sales team moves off SuiteCRM 7: accounts, contacts, leads, deals, notes and
tasks, a pipeline, lead conversion, the customer's manager-approval rule for large deals, and SuiteCRM's team-based
access rules. The behaviour, API contract and design brief are in `SPEC.md`; the database is `schema.sql`.

## Template vs per-job configuration

| Part | Where | Changes per job? |
| --- | --- | --- |
| Application code, templates, CSS/JS | `app/` | No. Written once; nothing is copied from SuiteCRM. |
| Database schema | `schema.sql` | No. The data migration writes into it. |
| Workspace configuration | the file named by `WORKSPACE_CONFIG` (example: `config.example.json`) | Yes. Generated from the inspection of the customer's SuiteCRM: workspace name, stages and probabilities, dropdowns, custom field labels, the approval rule's parameters and messages, access settings, lead-conversion options, links back to SuiteCRM. |
| Data | the PostgreSQL database named by `DATABASE_URL` | Yes. Filled by the data migration. |
| Secrets | environment only (`DATABASE_URL`, `SESSION_SECRET`) | Yes. Never in code or config.json. |

`GET /api/meta` serves the non-secret parts of the configuration (keys containing secret, password, token or
similar words are never included).

## Install

```bash
uv venv --python /opt/homebrew/bin/python3.13 var/venvs/sales-workspace-dev
uv pip install --python var/venvs/sales-workspace-dev/bin/python -r engine/targets/sales_workspace/requirements.txt
```

Every version in `requirements.txt` is pinned. The stack is FastAPI, Jinja2, psycopg 3 with a pool, and bcrypt. There
is no build step, no CDN and no external font.

## Run

From `engine/targets/sales_workspace/`:

```bash
DATABASE_URL='postgresql://USER:PASSWORD@127.0.0.1:54329/DBNAME' \
SESSION_SECRET='a long random string' \
WORKSPACE_CONFIG=config.example.json \
HOST=127.0.0.1 PORT=8090 \
../../../var/venvs/sales-workspace-dev/bin/python -m app
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `DATABASE_URL` | required | PostgreSQL 17 database created from `schema.sql` |
| `SESSION_SECRET` | random per process (a warning is logged; sessions end on restart) | key that signs the `lw_session` cookie |
| `WORKSPACE_CONFIG` | `config.example.json` next to this README | per-job configuration |
| `HOST` / `PORT` | `127.0.0.1` / `8090` | listen address |
| `DB_POOL_MIN` / `DB_POOL_MAX` | `1` / `10` | connection pool size |
| `SESSION_COOKIE_SECURE` | off | set to `1` behind HTTPS |

`GET /healthz` returns `{"ok": true}`, or 503 `{"ok": false}` while the database is unreachable.

To try it with the synthetic fixture: create an empty database, load `schema.sql` and then `tests/fixture.sql`, and
sign in as `pnair` (salesperson), `mchen` (sales manager), `dkim` (support) or `admin` with the fixture password
`TEST_PASSWORD` from `tests/conftest.py`.

## How it is built

- `app/access.py`: access levels, plus the SQL visibility clause used by every read and write.
  - The rule is SuiteCRM's additive ACL. For each entity and action the user gets the most permissive level among
    their roles' rows. No row on any of their roles means `all`. A disabled `access` makes every action `none`.
    Admins get `all`.
  - `own` means `owner_id`. `team` means owned, or a `record_teams` row for one of the user's teams.
  - Soft-deleted rows are excluded at every level.
- `app/rules.py`: the approval rule as a pure function (`apply_approval_rule`), and `save_deal`, the single path for
  every deal write (create, PATCH, pipeline move, approval endpoint, lead conversion). `save_deal`:
  - locks the row;
  - recomputes `amount_usd = round(amount / rate_per_usd, 6)` when the amount or currency changes;
  - decides whether the user is a team manager, applies rule steps 1–4 and writes the adjusted values with audit rows.
- `app/convert.py`: lead conversion.
  - Matching: exact matches use normalised names; similar matches use difflib at `similar_threshold` over viewable
    accounts. Similar accounts are only ever warnings.
  - The conversion runs in one transaction and locks the lead row. The `lead_conversions` primary key is the final
    guard: a request that loses a race rolls back everything it created and returns the winner's result.
- `app/services/`: the shared service layer, used by both `app/api.py` (JSON) and `app/pages.py` (HTML).
  - `base.py` holds errors, field validation, and the generic insert (with `record_teams` inheritance: creator ∪ owner,
    plus the parent's teams for notes and tasks), update (with `audit_log` rows for changed fields) and soft delete.
- `app/pages.py` and `app/templates/`: server-rendered pages with plain HTML forms (CSRF token from the session, then a
  redirect).
- `app/static/app.js`: enhances pipeline stage moves, approve/reject, adding notes and tasks, and completing tasks,
  using `fetch()` calls to the same JSON API. Every form still works without JavaScript.

## Status codes (JSON API)

| Status | When |
| --- | --- |
| 401 | Signed out (or the session was signed out, expired, or the user was deactivated). `POST /api/login` also returns 401 for a malformed body. |
| 403 | The record is viewable but not editable or deletable; creating without an edit level; listing an entity the user cannot list; a non-manager approving or rejecting (body `{"detail": <messages.not_manager>}`); the approval queue for a user who is neither an admin nor a holder of the manager role. |
| 404 | The id is unknown, soft-deleted or not viewable. This also covers records referenced in a body: a note's or task's parent, `account_id`, `contact_id`, the existing account in a conversion. |
| 415 | A mutation whose body is not JSON. |
| 422 | Validation errors, with `{"detail": "...", "errors": {field: message}}`. |

## Tests

```bash
var/venvs/sales-workspace-dev/bin/python -m pytest -q engine/targets/sales_workspace/tests
```

The tests create throwaway databases named `sw_test_*` on `127.0.0.1:54329` as `goose_admin`, reading the
password from `var/pg/admin-password`. They build one template database from `schema.sql` and `tests/fixture.sql`,
copy it for each test, and drop everything at the end. To use another server, set `SW_TEST_PG_HOST`,
`SW_TEST_PG_PORT`, `SW_TEST_PG_USER` or `SW_TEST_PG_PASSWORD_FILE`.

| File | Covers |
| --- | --- |
| `test_rules.py` | The approval rule unit tests: every branch, 25000.00 vs 25000.01, EUR, withdrawal, wrong-team manager, admin. Also access levels and name matching. |
| `test_access.py` | own/team/all, 404 vs 403, related-list filtering, Support's disabled entities, soft deletes, `record_teams` inheritance, audit rows. |
| `test_deals.py` | The approval rule through the API and the database, including bypass attempts; `amount_usd`; the pipeline; the approvals queue. |
| `test_convert.py` | Exact vs similar matches, idempotency, and concurrent double submit. The concurrency tests use two threads on two connections (with a deterministic wait on the row lock), the primary-key backstop, and a live HTTP server. |
| `test_api.py` | Sign-in and sessions, content types, validation, odd input, pagination, search, renewals, meta, CRUD flows. |
| `test_pages.py` | Every page for every role, forms with CSRF, the blocked Closed Won banner, approvals, conversion through the forms. |

## Screenshots

`screens/shoot.mjs` captures the main pages at 1920×1080 as `screens/*.png`. To take them:

1. Run the app on a fresh fixture database.
2. Run this from the project root:

   ```bash
   BASE_URL=http://127.0.0.1:8090 SW_PASSWORD=<TEST_PASSWORD> node engine/targets/sales_workspace/screens/shoot.mjs
   ```

The script uses the installed Google Chrome, like the project's Playwright config (`PW_CHANNEL=` switches to Playwright's
Chromium). It changes data: it makes two blocked Closed Won moves and one conversion.

## Decisions where SPEC.md leaves room

- **`/api/me`:** `roles` is a list of role names, `teams` is `[{id, name}]` and `is_manager_of_teams` is a list of team ids.
- **Missing approved amount:** a NULL `approved_amount_usd` counts as 0 in the withdrawal step, as in the customer's
  PHP hook.
- **Team manager:** the check uses the deal's owner after the change, as the hook uses `assigned_user_id`. A deal
  without an owner uses the acting user.
- **Probability:** it follows the stage unless the user sets a different value. A blocked won move keeps the old
  probability.
- **Unknown or read-only body fields** (`id`, `amount_usd`, `approved_*`, `converted_*`, `deleted_at`, …) are ignored.
- **Dropdown values:** a value must be in the configured list, unless it equals the stored (migrated) value. A list
  that config.json does not define is free text.
- **Pagination:** `per_page` is clamped to 1–100 and `page` to 1–1,000,000.
- **Logout** also ends the session on the server. The signed session id is kept, until the cookie's 8-hour lifetime
  would have ended, in the schema's generic `request_keys` table under a `session-revoked:` key.
- **Idempotent creates:** an optional `request_key` on any `POST /api/<entity>` makes a replay return the stored
  response. These are stored in `request_keys` under `<entity>:<key>`. Lead conversion uses
  `lead_conversions.request_key`, as SPEC.md says.
- **Lead conversion details:**
  - The new account gets only a name and the lead owner as owner.
  - The deal's owner is the lead owner, or the converting user if the lead owner is inactive.
  - A `request_key` already used for another lead is a 422.
- **Approval endpoint:** for approve or reject, the manager check (403 with the `not_manager` message) comes before the
  edit check.
