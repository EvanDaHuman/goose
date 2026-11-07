# Sales workspace: target application for the SuiteCRM sales-workflow recipe

This is the application Goose delivers when a customer asks to move their sales team off SuiteCRM 7 onto a modern
workspace while keeping their data, relationships, customizations and access rules. It is a **Goose template**:
the code here is written once by Goose; each job configures it with a `config.json` generated from the inspection of the
customer's SuiteCRM (stages, dropdowns, custom fields, the approval rule's parameters, access settings) and fills the
database with the data migration. Nothing here is copied from SuiteCRM (which is AGPLv3); only data and configuration
values move.

The schema is `schema.sql` (fixed; the migration writes into it). Record ids are SuiteCRM's ids kept as text.

## Stack
- Python 3.13, FastAPI, Jinja2 server-rendered pages with a little vanilla JavaScript (no build step, no CDN), psycopg 3
  with a connection pool, PostgreSQL 17. Pinned `requirements.txt`.
- Start: `python -m app` with environment `DATABASE_URL`, `SESSION_SECRET`, `PORT` (default 8090), `HOST` (default 127.0.0.1),
  `WORKSPACE_CONFIG` (path to config.json). Health: `GET /healthz` returns `{"ok": true}`.
- Sessions: signed cookie `lw_session` (HttpOnly, SameSite=Lax, 8 h). API mutations accept JSON only.

## Sign-in
- Users come from the migration (`users`). `password_scheme = 'suitecrm-bcrypt-md5'` means the stored hash is SuiteCRM 7's:
  `password_hash(strtolower(md5(password)))`, so check with `bcrypt.checkpw(md5(password).hexdigest().lower(), hash)`.
  `password_scheme = 'bcrypt'` is a plain bcrypt hash of the password (for users created later). Users with
  `status = 'inactive'` cannot sign in. Same error for unknown user and wrong password.
- `POST /api/login {user_name, password}` → 200 `{user}` and the cookie; 401 otherwise. `POST /api/logout`. `GET /api/me` →
  `{id, user_name, name, title, is_admin, roles:[...], teams:[...], is_manager_of_teams:[team ids]}`.
- Pages: `/login` form; every other page redirects to `/login` when signed out. API returns 401 when signed out.

## Access rules (enforced in the backend for every read and write; the UI only hides what the API would refuse)
Entities: `accounts, contacts, leads, deals, notes, tasks`. Actions: `access, list, view, edit, delete`.
- A user's level for (entity, action) is the most permissive level among their roles' `role_permissions` rows
  (SuiteCRM "additive" mode, `config.access.additive`). Order: `none < own < team < all`. No row means `all`
  (SuiteCRM's "Not set"). `access = disabled` hides the entity completely (treat every action as `none`). Admins: `all`.
- A record is **owned** by the user when `owner_id = user.id`. A record is **in the user's team** when it has a
  `record_teams` row for one of the user's teams. Level `own` allows owned records only. Level `team` allows owned records
  and records in the user's teams. Level `all` allows every record.
- `list` decides what appears in lists, search, the pipeline and related lists on a page. `view` decides whether a record
  page / `GET /api/<entity>/<id>` works. Not viewable → **404** (never reveal that it exists). Viewable but `edit` or
  `delete` not allowed → **403**.
- Related lists on a page are filtered with the `list` rule of their own entity (an account page shows only the deals,
  contacts, notes and tasks the user may list).
- Creating requires `edit` level other than `none`. New records: `owner_id` defaults to the creator (may be set to another
  active user); teams = creator's teams ∪ owner's teams (`inherit_creator`, `inherit_assigned`), and for notes and tasks
  also the parent record's teams (`inherit_parent`). Write `record_teams` rows accordingly.
- Deleting is a soft delete (`deleted_at = now()`); deleted rows never appear anywhere.
- Every update writes `audit_log` rows (source 'workspace') for changed fields.

## The approval rule (configured from `config.approval_rule`; exact semantics of the customer's SuiteCRM hook)
Applied inside **every** deal update (PATCH, stage moves on the pipeline, the approval endpoint, lead conversion that
creates a deal), in this order, with `before` = stored deal, `after` = deal with the requested changes, `u` = acting user:
1. If `after.approval_status != before.approval_status` and `after.approval_status in ('approved','rejected')` and
   `u` is not a team manager for the deal → keep `before.approval_status`; message `messages.not_manager`.
2. If `after.approval_status == 'approved'` and `before.approval_status != 'approved'` → `approved_amount_usd =
   after.amount_usd`, `approved_by = u.id`, `approved_at = now()`.
3. If `after.approval_status == 'approved'` and `after.amount_usd > approved_amount_usd + 0.005` → `approval_status =
   'requested'`; message `messages.withdrawn`.
4. If `after.stage == won_stage` and `before.stage != won_stage` and `after.amount_usd > threshold_usd` and
   `after.approval_status != 'approved'` → `stage = before.stage` (or `fallback_stage` for a new deal); if the approval status
   is '' or 'rejected' set it to 'requested'; message `messages.blocked`.
- **Team manager**: `u.is_admin`, or `u` has the role named `manager_role` and shares at least one team with the deal's
  owner (with the acting user when the deal has no owner).
- `amount_usd = round(amount / currency.rate_per_usd, 6)`, recomputed whenever amount or currency changes.
- The save itself succeeds (as in SuiteCRM) with the adjusted values: `PATCH /api/deals/{id}` returns 200 with
  `{deal, rule_messages: [...], blocked: true|false}`. The UI shows the messages prominently.
- `POST /api/deals/{id}/approval {decision: 'requested'|'approved'|'rejected'}` is the explicit endpoint: 403 with the
  `not_manager` message when a non-manager tries to approve or reject (a clearer API than SuiteCRM's silent revert; documented
  as an intended difference), otherwise it runs the same rule path.
- `GET /api/approvals` (managers): deals with approval `requested` that the user may list and is a team manager for.

## Lead conversion (the agreed workflow; `config.lead_conversion`)
- `GET /api/leads/{id}/conversion` → `{lead, already_converted, result?, exact_matches: [accounts], similar: [accounts]}`.
  Exact match: an account the user may **view** whose name equals the lead's company after trimming, collapsing spaces and
  ignoring case. Similar: other viewable accounts with a similarity ratio ≥ `similar_threshold` (difflib on the normalised
  names). Similar accounts are shown as warnings and are **never** linked automatically.
- `POST /api/leads/{id}/convert {request_key, account: {"mode":"existing","id":...} | {"mode":"new","name":...},
  create_deal: bool, deal?: {name, amount, currency_code, stage, close_date}}` →
  201 `{contact_id, account_id, deal_id, account_created, already_converted: false}`.
  - One transaction: create the contact from the lead (first/last name, title, email, phone, city, lead_source; owner = lead
    owner); link to the chosen existing account, or create the new account (owner = lead owner); optionally create the deal
    linked to account and contact (`deal_contacts.role = default_contact_role`), through the same deal rules; set the lead's
    `status = 'Converted'`, `converted = true` and the `converted_*` ids; insert `lead_conversions`.
  - `activities = 'donothing'`: the lead's notes and tasks stay on the lead.
  - Idempotent: if the lead is already converted (any request key), return 200 with the stored result and
    `already_converted: true`, creating nothing. A replayed `request_key` returns the same result. Two concurrent requests
    must not create two contacts (rely on the `lead_conversions` primary key inside the transaction).
  - Requires `edit` on the lead and `edit` on contacts (and accounts/deals when creating them); an existing account must be
    viewable.

## JSON API (all under /api; lists support `q`, `page`, `per_page` (≤100); every list returns `{items, total}`)
- `GET /api/search?q=` → `{accounts, contacts, leads, deals}` (≤10 each; name, company, e-mail, city; list rule applied).
- Accounts: `GET /api/accounts`, `POST /api/accounts`, `GET /api/accounts/{id}` → `{account, contacts, deals, notes, tasks,
  external_links, teams, owner}`, `PATCH /api/accounts/{id}`, `DELETE /api/accounts/{id}`.
- Contacts, leads, deals, notes, tasks: the same five routes (`GET` detail of a contact includes its account, deals, notes,
  tasks; of a deal includes account, contacts with roles, notes, tasks, approval panel; of a lead includes notes, tasks and the
  conversion state). Notes and tasks are created with `parent_type` ∈ {account, contact, deal, lead} and `parent_id`; the user
  must be able to view the parent.
- `GET /api/pipeline?scope=mine|team|all` → stages in configured order with deals (the list rule) and USD totals.
- `GET /api/renewals?days=90` → accounts the user may list with `contract_renewal_date` in the next N days, soonest first.
- `GET /api/meta` → the non-secret parts of config.json (stages, dropdowns, rule parameters, source system, synthetic flag).
- Validation errors → 422 with `{detail}`. Unknown or soft-deleted ids → 404.

## Pages (server-rendered; the same rules through the same service functions as the API)
Design brief: a calm, modern workspace for salespeople. System font stack, 15 px base, generous whitespace, white cards on
a light warm-grey background, one accent colour (a muted blue-violet, e.g. #4b55c4), clear status pills (stage,
approval: requested = amber, approved = green, rejected = red), tabular numbers for money, dates as "31 Mar 2027" with a
relative hint ("renews in 147 days"). Readable at 1920×1080 for screen recordings. Always-visible header: workspace name,
a "Synthetic demo data" badge (`config.synthetic`), global search box, Pipeline / Accounts / Contacts / Leads / Approvals
(managers only, with a count), signed-in user with role and team, sign out. Footer: "Delivered by Goose · job <id> ·
data migrated from SuiteCRM <version> snapshot <time>".
- `/` home: my open deals, renewals in the next 90 days, my open tasks, approvals waiting (managers).
- `/search?q=` grouped results. `/accounts` searchable list with owner, team, renewal date, open pipeline value.
- `/accounts/{id}`: header (name, type, industry, city, phone, website, owner, team, contract renewal date + relative hint),
  sections Contacts, Deals (stage and approval pills, amounts in the deal's currency with the USD value when not USD), Notes
  (timeline, newest first, with author and the contact they concern), Tasks (status, due date), "In SuiteCRM" links
  (`external_links`: support cases, meetings, calls that stay in the original system), add note / add task inline, edit.
- `/contacts`, `/contacts/{id}`; `/leads`, `/leads/{id}` with a **Convert** button → `/leads/{id}/convert` (exact match
  pre-selected as "Link to existing account", similar names shown with a warning "different customer — not linked unless you
  choose it", option to create a new account, optional deal) → result page; converting again shows "Already converted" with
  links.
- `/pipeline`: columns per stage with count and USD total; deal cards (name, account, amount, owner, approval pill); move
  a deal to another stage with a small control (no drag-and-drop needed). A blocked move shows the rule message on the card
  and at the top of the page.
- `/deals/{id}`: details, edit form, stage control, approval panel (status, approved by, approved amount, approved at;
  "Request approval" for anyone who can edit; "Approve"/"Reject" only for team managers; otherwise an explanation).
- `/approvals`: manager queue with Approve / Reject.
- Create/edit forms for accounts, contacts, leads, deals; inline add for notes and tasks. Errors from the API (403, 422) shown
  inline, never as raw JSON.

## Tests (pytest, against a throwaway PostgreSQL database created from schema.sql + tests/fixture.sql)
Approval rule unit tests (every branch, boundary 25000.00 vs 25000.01, EUR conversion, wrong-team manager, admin,
withdrawal on amount increase), access tests (own/team/all, 404 vs 403, related-list filtering), conversion tests (exact vs
similar, idempotency, concurrent double submit), and API flow tests with the FastAPI test client.
