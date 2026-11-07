-- Goose company records. Applied by scripts/migrate.ts (safe to re-run).

CREATE TABLE IF NOT EXISTS accounts (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name          TEXT NOT NULL,
    contact_name  TEXT,
    contact_email TEXT,
    kind          TEXT NOT NULL CHECK (kind IN ('demo', 'real')),
    acquired_via  TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS prospects (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL UNIQUE,
    category        TEXT,
    summary         TEXT,
    evidence        JSONB NOT NULL DEFAULT '[]',
    scope_fit       TEXT,
    blockers        JSONB NOT NULL DEFAULT '[]',
    access_path     TEXT,
    contact_channel TEXT,
    fit_score       TEXT,
    last_activity   TEXT,
    researched_on   DATE,
    status          TEXT NOT NULL DEFAULT 'researched'
                    CHECK (status IN ('researched', 'draft_ready', 'contacted', 'replied', 'qualified', 'won', 'lost')),
    outreach_draft  TEXT,
    notes           TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
    id                   TEXT PRIMARY KEY,                 -- e.g. GS-1001
    account_id           BIGINT NOT NULL REFERENCES accounts (id),
    title                TEXT NOT NULL,
    kind                 TEXT NOT NULL CHECK (kind IN ('demo', 'real')),
    app_slug             TEXT NOT NULL,
    timezone             TEXT NOT NULL,
    mode                 TEXT NOT NULL CHECK (mode IN ('local', 'naive')),
    stage                TEXT NOT NULL,
    status               TEXT NOT NULL CHECK (status IN ('running', 'waiting_customer', 'waiting_founder',
                                                         'done', 'rejected', 'declined', 'cancelled')),
    waiting_reason       TEXT,
    responsible          TEXT NOT NULL,                    -- agent role currently holding the job
    round                INTEGER NOT NULL DEFAULT 1,       -- intake/assess/propose round (new uploads or answers)
    attempt              INTEGER NOT NULL DEFAULT 1,       -- modernize/migrate/verify cycle
    repair_budget        INTEGER NOT NULL,
    repairs_used         INTEGER NOT NULL DEFAULT 0,
    price_cents          INTEGER,
    cost_limit_micro_usd BIGINT NOT NULL,
    test_fault           TEXT,                             -- set only by a founder intervention
    customer_token       TEXT NOT NULL,                    -- the link the customer uses
    checks_manifest_sha  TEXT,
    next_run_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_owner          TEXT,
    lease_expires_at     TIMESTAMPTZ,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_runnable ON jobs (status, next_run_at);

CREATE TABLE IF NOT EXISTS job_inputs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES jobs (id),
    kind         TEXT NOT NULL CHECK (kind IN ('repository', 'database')),
    filename     TEXT NOT NULL,
    size_bytes   BIGINT NOT NULL,
    sha256       TEXT NOT NULL,
    stored_path  TEXT NOT NULL,
    validation   JSONB,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per stage attempt. A stage that succeeded is never run again for the same attempt.
CREATE TABLE IF NOT EXISTS stage_runs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES jobs (id),
    stage        TEXT NOT NULL,
    attempt      INTEGER NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'blocked')),
    actor        TEXT NOT NULL,
    mode         TEXT NOT NULL,
    runs         INTEGER NOT NULL DEFAULT 1,               -- >1 means it was resumed after an interruption
    started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at  TIMESTAMPTZ,
    output       JSONB,
    error        TEXT,
    UNIQUE (job_id, stage, attempt)
);

-- The activity record: every decision, hand-over, check result and message, in order.
CREATE TABLE IF NOT EXISTS events (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id     TEXT REFERENCES jobs (id),
    at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor      TEXT NOT NULL,     -- commercial | coordinator | modernization | verification | customer | founder | system
    kind       TEXT NOT NULL,     -- decision | handoff | status | check | cost | message | approval | intervention | artifact | error
    important  BOOLEAN NOT NULL DEFAULT false,
    summary    TEXT NOT NULL,
    detail     JSONB,
    source     TEXT NOT NULL DEFAULT 'local'   -- local | naive (where the work actually ran)
);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id, id);

CREATE TABLE IF NOT EXISTS questions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES jobs (id),
    key          TEXT NOT NULL,
    asked_by     TEXT NOT NULL,
    audience     TEXT NOT NULL CHECK (audience IN ('customer', 'founder')),
    prompt       TEXT NOT NULL,
    fields       JSONB NOT NULL DEFAULT '[]',
    options_help JSONB,
    recommended  TEXT,
    blocking     BOOLEAN NOT NULL DEFAULT true,
    status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'withdrawn')),
    answer       JSONB,
    answered_by  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    answered_at  TIMESTAMPTZ,
    UNIQUE (job_id, key)
);

CREATE TABLE IF NOT EXISTS proposals (
    id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id               TEXT NOT NULL REFERENCES jobs (id),
    version              INTEGER NOT NULL,
    scope                JSONB NOT NULL,
    summary              JSONB NOT NULL,
    price_cents          INTEGER NOT NULL,
    cost_limit_micro_usd BIGINT NOT NULL,
    delivery_days        INTEGER NOT NULL,
    status               TEXT NOT NULL CHECK (status IN ('sent', 'accepted', 'declined', 'superseded')),
    scope_sha256         TEXT NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    decided_at           TIMESTAMPTZ,
    UNIQUE (job_id, version)
);

-- What the CUSTOMER agreed to. Kept apart from founder interventions on purpose.
CREATE TABLE IF NOT EXISTS approvals (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs (id),
    kind        TEXT NOT NULL CHECK (kind IN ('proposal', 'delivery', 'change')),
    decision    TEXT NOT NULL CHECK (decision IN ('accepted', 'declined')),
    by_name     TEXT NOT NULL,
    by_email    TEXT,
    statement   TEXT NOT NULL,
    reference   TEXT,          -- proposal version / delivery package sha256
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Everything the FOUNDER did by hand. Each one counts against "how much runs without you".
CREATE TABLE IF NOT EXISTS interventions (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id     TEXT REFERENCES jobs (id),
    kind       TEXT NOT NULL,
    reason     TEXT NOT NULL,
    detail     JSONB,
    minutes    INTEGER NOT NULL DEFAULT 0,
    at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS artifacts (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs (id),
    kind        TEXT NOT NULL,
    label       TEXT NOT NULL,
    path        TEXT NOT NULL,
    sha256      TEXT,
    size_bytes  BIGINT,
    attempt     INTEGER,
    created_by  TEXT NOT NULL,
    frozen      BOOLEAN NOT NULL DEFAULT false,
    customer_visible BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, kind, attempt, label)
);

CREATE TABLE IF NOT EXISTS check_runs (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id        TEXT NOT NULL REFERENCES jobs (id),
    attempt       INTEGER NOT NULL,
    integrity_ok  BOOLEAN NOT NULL,
    total         INTEGER NOT NULL,
    passed        INTEGER NOT NULL,
    failed        INTEGER NOT NULL,
    skipped       INTEGER NOT NULL,
    verdict       TEXT NOT NULL,
    by_category   JSONB NOT NULL,
    failed_checks JSONB NOT NULL,
    report_path   TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, attempt)
);

CREATE TABLE IF NOT EXISTS repairs (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id       TEXT NOT NULL REFERENCES jobs (id),
    attempt      INTEGER NOT NULL,          -- the failed verification attempt it responds to
    diagnoses    JSONB NOT NULL,
    actions      JSONB NOT NULL,
    diff         TEXT NOT NULL,
    unresolved   JSONB NOT NULL,
    outcome      TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending', 'fixed', 'not_fixed', 'escalated')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, attempt)
);

-- Every cost, including failed attempts and retries. basis says how the number was obtained.
CREATE TABLE IF NOT EXISTS cost_entries (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id      TEXT REFERENCES jobs (id),
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor       TEXT NOT NULL,
    stage       TEXT,
    attempt     INTEGER,
    kind        TEXT NOT NULL CHECK (kind IN ('model', 'compute', 'search', 'other')),
    quantity    NUMERIC NOT NULL,
    unit        TEXT NOT NULL,
    micro_usd   BIGINT NOT NULL,
    basis       TEXT NOT NULL CHECK (basis IN ('naive_metered', 'estimate_naive_rate', 'none')),
    naive_session_id TEXT,
    note        TEXT
);
CREATE INDEX IF NOT EXISTS cost_job ON cost_entries (job_id);

CREATE TABLE IF NOT EXISTS invoices (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id        TEXT NOT NULL REFERENCES jobs (id) UNIQUE,
    number        TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'paid', 'void')),
    is_test       BOOLEAN NOT NULL,
    amount_cents  INTEGER NOT NULL,
    currency      TEXT NOT NULL DEFAULT 'USD',
    line_items    JSONB NOT NULL,
    notes         TEXT,
    issued_at     TIMESTAMPTZ,
    due_at        TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    invoice_id   BIGINT NOT NULL REFERENCES invoices (id),
    amount_cents INTEGER NOT NULL,
    is_test      BOOLEAN NOT NULL,
    method       TEXT NOT NULL,
    reference    TEXT,
    recorded_by  TEXT NOT NULL,
    at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS followups (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id     TEXT NOT NULL REFERENCES jobs (id),
    kind       TEXT NOT NULL,
    due_at     TIMESTAMPTZ NOT NULL,
    status     TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'drafted', 'done', 'cancelled')),
    draft      TEXT,
    done_at    TIMESTAMPTZ,
    UNIQUE (job_id, kind)
);

CREATE TABLE IF NOT EXISTS messages (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id      TEXT NOT NULL REFERENCES jobs (id),
    sender      TEXT NOT NULL,          -- customer | commercial | founder
    body        TEXT NOT NULL,
    in_reply_to BIGINT REFERENCES messages (id),
    handled_by  TEXT,                   -- who answered: commercial agent (local/naive) or founder
    needs_founder BOOLEAN NOT NULL DEFAULT false,
    at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Naive resources this company created (agents, board). Lets provisioning run twice safely.
CREATE TABLE IF NOT EXISTS naive_resources (
    role        TEXT PRIMARY KEY,
    naive_id    TEXT NOT NULL,
    version     INTEGER,
    config_sha  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS naive_sessions (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id            TEXT REFERENCES jobs (id),
    stage             TEXT,
    role              TEXT NOT NULL,
    session_id        TEXT NOT NULL UNIQUE,
    card_id           TEXT,
    status            TEXT,
    stop_reason       TEXT,
    consumed_micro_usd BIGINT NOT NULL DEFAULT 0,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_counter (id INTEGER PRIMARY KEY DEFAULT 1, next_value INTEGER NOT NULL);
INSERT INTO job_counter (id, next_value) VALUES (1, 1001) ON CONFLICT DO NOTHING;

-- A running copy of a delivered app that people can try. Started and stopped by the worker.
CREATE TABLE IF NOT EXISTS showrooms (
    job_id      TEXT PRIMARY KEY REFERENCES jobs (id),
    status      TEXT NOT NULL CHECK (status IN ('requested', 'running', 'stop_requested', 'stopped', 'failed')),
    port        INTEGER,
    pid         INTEGER,
    detail      TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
