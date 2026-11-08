-- Prospect outreach over AgentMail. The research agent finds the repository and what is outdated, the qualification agent
-- decides how Goose would fix it, the outreach agent drafts; this adds the last steps: resolving a published business contact
-- address, sending one exact message per prospect, and recording replies and opt-outs.
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_source TEXT;            -- the public page the address was published on
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_kind TEXT;              -- 'business' (role address on the organisation's site) or 'profile' (public GitHub profile)
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_checked_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contact_note TEXT;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ;
ALTER TABLE prospects ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;

-- Addresses that must never receive outreach again (opt-out replies, bounces, manual).
CREATE TABLE IF NOT EXISTS outreach_suppressions (
 email TEXT PRIMARY KEY, reason TEXT NOT NULL, source TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per outbound prospect email. The content hash binds an authorization to the exact message.
CREATE TABLE IF NOT EXISTS outreach_messages (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 prospect_id BIGINT NOT NULL REFERENCES prospects(id),
 recipient TEXT NOT NULL, delivered_to TEXT, subject TEXT NOT NULL, body TEXT NOT NULL, content_sha256 TEXT NOT NULL,
 is_test BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sending','sent','failed','uncertain','cancelled')),
 provider_message_id TEXT, thread_id TEXT, authorized_by TEXT, authorized_at TIMESTAMPTZ,
 error TEXT, sent_at TIMESTAMPTZ, replied_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- At most one live (not cancelled/failed) real message per prospect.
CREATE UNIQUE INDEX IF NOT EXISTS outreach_one_live_per_prospect ON outreach_messages(prospect_id)
 WHERE NOT is_test AND status IN ('draft','sending','sent','uncertain');
CREATE INDEX IF NOT EXISTS outreach_thread ON outreach_messages(thread_id) WHERE thread_id IS NOT NULL;

ALTER TABLE commerce_inbound_messages ADD COLUMN IF NOT EXISTS outreach_message_id BIGINT REFERENCES outreach_messages(id);
