-- Where a job's repository came from when it was read from GitHub instead of uploaded:
-- {"provider":"github","repo":"owner/name","url":...,"ref":"main","commit":"<sha>","private":true,"access":"app"|"public","fetchedAt":...}
ALTER TABLE job_inputs ADD COLUMN IF NOT EXISTS source JSONB;
