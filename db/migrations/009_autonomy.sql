-- Autonomous recovery: the worker resolves jobs that stopped for the founder, without a person.
-- Counts and timing of automatic recoveries per job, so retries back off and are bounded.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_recoveries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_recovered_at TIMESTAMPTZ;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS auto_extra_repairs INTEGER NOT NULL DEFAULT 0;
