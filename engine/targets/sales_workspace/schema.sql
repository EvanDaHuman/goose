-- Sales workspace: the target database for Goose's SuiteCRM sales-workflow recipe (PostgreSQL 17).
-- Record ids are the SuiteCRM ids, kept as text, so every migrated record can be traced to its source row.
-- Rows written by the migration have source = 'suitecrm'; rows created in the workspace have source = 'workspace'.

CREATE TABLE app_meta (
  key   text PRIMARY KEY,
  value jsonb NOT NULL
);

CREATE TABLE teams (
  id     text PRIMARY KEY,
  name   text NOT NULL UNIQUE,
  source text NOT NULL DEFAULT 'workspace'
);

CREATE TABLE roles (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  description text,
  source      text NOT NULL DEFAULT 'workspace'
);

-- Access levels follow SuiteCRM's role actions: all (90), team (80, "Group"), own (75, "Owner"), none (-99);
-- 'access' uses enabled (89) / disabled (-98). A missing row means SuiteCRM's "Not set", which allows.
CREATE TABLE role_permissions (
  role_id text NOT NULL REFERENCES roles(id),
  entity  text NOT NULL CHECK (entity IN ('accounts','contacts','leads','deals','notes','tasks')),
  action  text NOT NULL CHECK (action IN ('access','list','view','edit','delete','export')),
  level   text NOT NULL CHECK (level IN ('all','team','own','none','enabled','disabled')),
  PRIMARY KEY (role_id, entity, action)
);

CREATE TABLE users (
  id              text PRIMARY KEY,
  user_name       text NOT NULL UNIQUE,
  first_name      text,
  last_name       text,
  title           text,
  email           text,
  status          text NOT NULL CHECK (status IN ('active','inactive')),
  is_admin        boolean NOT NULL DEFAULT false,
  reports_to      text REFERENCES users(id),
  password_hash   text,
  password_scheme text CHECK (password_scheme IN ('suitecrm-bcrypt-md5','bcrypt')),
  timezone        text NOT NULL DEFAULT 'UTC',
  source          text NOT NULL DEFAULT 'workspace'
);

CREATE TABLE user_roles (
  user_id text NOT NULL REFERENCES users(id),
  role_id text NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE user_teams (
  user_id text NOT NULL REFERENCES users(id),
  team_id text NOT NULL REFERENCES teams(id),
  PRIMARY KEY (user_id, team_id)
);

-- SuiteCRM's conversion_rate: units of the currency per US dollar (USD = 1).
CREATE TABLE currencies (
  code         text PRIMARY KEY,
  name         text NOT NULL,
  symbol       text NOT NULL,
  rate_per_usd numeric(18,6) NOT NULL CHECK (rate_per_usd > 0),
  source_id    text
);

CREATE TABLE accounts (
  id                    text PRIMARY KEY,
  name                  text NOT NULL,
  account_type          text,
  industry              text,
  phone                 text,
  website               text,
  billing_city          text,
  billing_state         text,
  billing_country       text,
  employees             text,
  description           text,
  contract_renewal_date date,
  owner_id              text REFERENCES users(id),
  created_by            text REFERENCES users(id),
  created_at            timestamptz NOT NULL,
  updated_at            timestamptz NOT NULL,
  deleted_at            timestamptz,
  source                text NOT NULL DEFAULT 'workspace'
);
CREATE INDEX accounts_name_idx ON accounts (lower(name));

CREATE TABLE contacts (
  id          text PRIMARY KEY,
  first_name  text,
  last_name   text NOT NULL,
  title       text,
  email       text,
  phone       text,
  city        text,
  state       text,
  lead_source text,
  description text,
  account_id  text REFERENCES accounts(id),
  owner_id    text REFERENCES users(id),
  created_by  text REFERENCES users(id),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  deleted_at  timestamptz,
  source      text NOT NULL DEFAULT 'workspace'
);
CREATE INDEX contacts_account_idx ON contacts (account_id);

CREATE TABLE deals (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  account_id          text REFERENCES accounts(id),
  stage               text NOT NULL,
  probability         integer,
  amount              numeric(26,6) NOT NULL,
  currency_code       text NOT NULL REFERENCES currencies(code),
  amount_usd          numeric(26,6) NOT NULL,
  close_date          date,
  lead_source         text,
  next_step           text,
  description         text,
  approval_status     text NOT NULL DEFAULT '' CHECK (approval_status IN ('','requested','approved','rejected')),
  approved_by         text REFERENCES users(id),
  approved_amount_usd numeric(26,2),
  approved_at         timestamptz,
  owner_id            text REFERENCES users(id),
  created_by          text REFERENCES users(id),
  created_at          timestamptz NOT NULL,
  updated_at          timestamptz NOT NULL,
  deleted_at          timestamptz,
  source              text NOT NULL DEFAULT 'workspace'
);
CREATE INDEX deals_account_idx ON deals (account_id);

CREATE TABLE deal_contacts (
  deal_id    text NOT NULL REFERENCES deals(id),
  contact_id text NOT NULL REFERENCES contacts(id),
  role       text,
  PRIMARY KEY (deal_id, contact_id)
);

CREATE TABLE leads (
  id                   text PRIMARY KEY,
  first_name           text,
  last_name            text NOT NULL,
  company              text,
  title                text,
  email                text,
  phone                text,
  city                 text,
  status               text NOT NULL,
  lead_source          text,
  description          text,
  converted            boolean NOT NULL DEFAULT false,
  converted_contact_id text REFERENCES contacts(id),
  converted_account_id text REFERENCES accounts(id),
  converted_deal_id    text REFERENCES deals(id),
  owner_id             text REFERENCES users(id),
  created_by           text REFERENCES users(id),
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  deleted_at           timestamptz,
  source               text NOT NULL DEFAULT 'workspace'
);

-- One row per converted lead: the guarantee that converting twice cannot create a second contact, account or deal.
CREATE TABLE lead_conversions (
  lead_id         text PRIMARY KEY REFERENCES leads(id),
  request_key     text UNIQUE,
  contact_id      text NOT NULL REFERENCES contacts(id),
  account_id      text REFERENCES accounts(id),
  deal_id         text REFERENCES deals(id),
  account_created boolean NOT NULL,
  converted_by    text REFERENCES users(id),
  converted_at    timestamptz NOT NULL
);

CREATE TABLE notes (
  id          text PRIMARY KEY,
  subject     text NOT NULL,
  body        text,
  parent_type text NOT NULL CHECK (parent_type IN ('account','contact','deal','lead')),
  parent_id   text NOT NULL,
  contact_id  text REFERENCES contacts(id),
  owner_id    text REFERENCES users(id),
  created_by  text REFERENCES users(id),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  deleted_at  timestamptz,
  source      text NOT NULL DEFAULT 'workspace'
);
CREATE INDEX notes_parent_idx ON notes (parent_type, parent_id);

CREATE TABLE tasks (
  id          text PRIMARY KEY,
  subject     text NOT NULL,
  status      text NOT NULL,
  priority    text,
  due_at      timestamptz,
  parent_type text CHECK (parent_type IN ('account','contact','deal','lead')),
  parent_id   text,
  contact_id  text REFERENCES contacts(id),
  description text,
  owner_id    text REFERENCES users(id),
  created_by  text REFERENCES users(id),
  created_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL,
  deleted_at  timestamptz,
  source      text NOT NULL DEFAULT 'workspace'
);
CREATE INDEX tasks_parent_idx ON tasks (parent_type, parent_id);

-- Which teams a record belongs to (SuiteCRM securitygroups_records).
CREATE TABLE record_teams (
  entity    text NOT NULL CHECK (entity IN ('accounts','contacts','leads','deals','notes','tasks')),
  record_id text NOT NULL,
  team_id   text NOT NULL REFERENCES teams(id),
  PRIMARY KEY (entity, record_id, team_id)
);

-- Field history: SuiteCRM's *_audit rows (source 'suitecrm') and changes made in the workspace.
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  entity     text NOT NULL,
  record_id  text NOT NULL,
  field      text NOT NULL,
  before     text,
  after      text,
  changed_by text,
  changed_at timestamptz NOT NULL,
  source     text NOT NULL DEFAULT 'workspace'
);
CREATE INDEX audit_record_idx ON audit_log (entity, record_id);

-- Things that stay in SuiteCRM but belong to a sales record (support cases, meetings, calls), shown as links.
CREATE TABLE external_links (
  entity    text NOT NULL,
  record_id text NOT NULL,
  system    text NOT NULL,
  kind      text NOT NULL,
  count     integer NOT NULL,
  url       text NOT NULL,
  PRIMARY KEY (entity, record_id, system, kind)
);

CREATE TABLE request_keys (
  key        text PRIMARY KEY,
  user_id    text NOT NULL,
  response   jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
