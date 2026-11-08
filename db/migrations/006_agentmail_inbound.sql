-- Native AgentMail receipts retain exact source strings separately from inquiry display text.
CREATE TABLE IF NOT EXISTS commerce_inbound_messages (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 event_id TEXT NOT NULL UNIQUE, svix_id TEXT NOT NULL, event_type TEXT NOT NULL,
 payload_sha256 TEXT NOT NULL, inbox_id TEXT, message_id TEXT, sender TEXT,
 subject TEXT, text_body TEXT, html_body TEXT, is_test BOOLEAN NOT NULL,
 outcome TEXT NOT NULL CHECK(outcome IN ('inquiry','ignored','needs_review')),
 reason TEXT, inquiry_id BIGINT REFERENCES commerce_inquiries(id),
 received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
