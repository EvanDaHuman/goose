-- Version 2: a job carries the customer's goal and constraints, the plans written for it, and where each
-- recorded step came from. Jobs created before this keep pipeline = 1 and their original labels.

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS pipeline INTEGER NOT NULL DEFAULT 1;   -- 1 = fixed conversion (history), 2 = plan-driven
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS goal TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS constraints JSONB NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS constraint_notes TEXT;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS recipe TEXT;          -- execution tools chosen by the accepted plan
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS work_type TEXT;       -- code | data | combined
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS source_stack JSONB;   -- what inspection found

-- every plan version, who wrote it, what the guard said, and why it replaced the one before
CREATE TABLE IF NOT EXISTS plans (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    job_id          TEXT NOT NULL REFERENCES jobs (id),
    version         INTEGER NOT NULL,
    author_kind     TEXT NOT NULL CHECK (author_kind IN ('agent', 'tool', 'human')),
    author          TEXT NOT NULL,
    naive_session_id TEXT,
    plan            JSONB NOT NULL,
    guard_problems  JSONB NOT NULL DEFAULT '[]',
    changed_because TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id, version)
);

-- provenance: agent (a Naive session), tool (deterministic code), human (customer or founder), fixture (demo input or
-- test fault), system. NULL means the row was recorded before provenance tracking and is shown as such.
ALTER TABLE events ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS origin_detail JSONB;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS origin_detail JSONB;

ALTER TABLE job_inputs DROP CONSTRAINT IF EXISTS job_inputs_kind_check;
ALTER TABLE job_inputs ADD CONSTRAINT job_inputs_kind_check CHECK (kind IN ('repository', 'database', 'document'));

ALTER TABLE naive_sessions ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE naive_sessions ADD COLUMN IF NOT EXISTS purpose TEXT;
ALTER TABLE naive_sessions ADD COLUMN IF NOT EXISTS output JSONB;
