-- Durable commercial operations. Synthetic actions remain separate from real business.
CREATE TABLE IF NOT EXISTS commerce_inquiries (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 public_id TEXT NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT NOT NULL,
 organization TEXT NOT NULL, goal TEXT NOT NULL, repository_url TEXT,
 is_test BOOLEAN NOT NULL DEFAULT false, source TEXT NOT NULL DEFAULT 'website',
 status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','linked','closed')),
 job_id TEXT REFERENCES jobs(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commerce_outbox (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 dedupe_key TEXT UNIQUE, job_id TEXT REFERENCES jobs(id), inquiry_id BIGINT REFERENCES commerce_inquiries(id),
 recipient TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, content_sha256 TEXT NOT NULL,
 is_test BOOLEAN NOT NULL DEFAULT false,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sending','sent','failed','uncertain','cancelled')),
 provider TEXT, provider_id TEXT, authorized_by TEXT, authorized_at TIMESTAMPTZ,
 error TEXT, sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commerce_checkouts (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, invoice_id BIGINT NOT NULL UNIQUE REFERENCES invoices(id),
 provider TEXT NOT NULL, provider_id TEXT NOT NULL UNIQUE, url TEXT NOT NULL, is_test BOOLEAN NOT NULL,
 status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','paid','expired')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commerce_webhook_events (
 provider TEXT NOT NULL, event_id TEXT NOT NULL, event_type TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL, received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(provider,event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_provider_reference ON payments(method,reference)
 WHERE reference IS NOT NULL AND method IN ('stripe','local_test');
CREATE TABLE IF NOT EXISTS commerce_tickets (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id),
 subject TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open'
 CHECK(status IN ('open','change_requested','resolved')), resolution TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), resolved_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS commerce_maintenance (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
 scope TEXT NOT NULL, interval_days INTEGER NOT NULL CHECK(interval_days IN (7,30)),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','cancelled')),
 consent_at TIMESTAMPTZ NOT NULL, next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 lease_until TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS commerce_checks (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, plan_id BIGINT NOT NULL REFERENCES commerce_maintenance(id),
 status TEXT NOT NULL CHECK(status IN ('running','passed','attention','failed')),
 detail JSONB NOT NULL DEFAULT '{}', started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS commerce_change_requests (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, parent_job_id TEXT NOT NULL REFERENCES jobs(id),
 ticket_id BIGINT UNIQUE REFERENCES commerce_tickets(id), check_id BIGINT UNIQUE REFERENCES commerce_checks(id),
 goal TEXT NOT NULL, budget_micro_usd BIGINT NOT NULL CHECK(budget_micro_usd > 0),
 status TEXT NOT NULL DEFAULT 'awaiting_source' CHECK(status IN ('awaiting_source','starting','started','cancelled')),
 child_job_id TEXT UNIQUE REFERENCES jobs(id), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE commerce_inquiries ADD COLUMN IF NOT EXISTS external_event_id TEXT UNIQUE;
ALTER TABLE commerce_inquiries ADD COLUMN IF NOT EXISTS payload_sha256 TEXT;
ALTER TABLE commerce_outbox ADD COLUMN IF NOT EXISTS purpose TEXT
 CHECK(purpose IS NULL OR purpose IN ('proposal','delivery','invoice','support'));
ALTER TABLE commerce_change_requests ADD COLUMN IF NOT EXISTS starting_at TIMESTAMPTZ;
-- Upgrade invoice templates prepared by the earlier commerce version. Other operator drafts remain manual.
UPDATE commerce_outbox o SET purpose='invoice' FROM invoices i
 WHERE o.dedupe_key='invoice:'||i.id AND o.job_id=i.job_id AND o.is_test=i.is_test
 AND o.purpose IS NULL AND o.status='draft' AND o.authorized_at IS NULL;
