-- Naive sessions: one row per agent task, found again by its idempotency key after a restart.
ALTER TABLE naive_sessions ADD COLUMN IF NOT EXISTS idem_key TEXT;
ALTER TABLE naive_sessions ADD COLUMN IF NOT EXISTS attempt INTEGER;
ALTER TABLE naive_sessions ADD COLUMN IF NOT EXISTS token_usage JSONB;
ALTER TABLE naive_sessions ADD COLUMN IF NOT EXISTS transcript_path TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS naive_sessions_idem_key ON naive_sessions (idem_key) WHERE idem_key IS NOT NULL;
-- files this company put in its Naive file library for a job (deleted after delivery)
CREATE TABLE IF NOT EXISTS naive_files (
    file_id     TEXT PRIMARY KEY,
    job_id      TEXT REFERENCES jobs (id),
    direction   TEXT NOT NULL CHECK (direction IN ('uploaded', 'published_by_agent')),
    name        TEXT NOT NULL,
    size_bytes  BIGINT,
    sha256      TEXT,
    deleted_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
