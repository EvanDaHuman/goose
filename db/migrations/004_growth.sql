-- The growth agents (research, qualification, outreach) work on the prospect pipeline. Each prospect records who found it,
-- who qualified it and who drafted its outreach, so the operator page can show which steps an agent did.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS found_by TEXT NOT NULL DEFAULT 'founder research';
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS found_session_id TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS qualification JSONB;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS qualified_by TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS qualified_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS drafted_by TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS drafted_at TIMESTAMPTZ;
