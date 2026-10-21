-- Server-only persistence. This schema is intentionally not exposed in the Data API.
CREATE SCHEMA IF NOT EXISTS chatbot;
REVOKE ALL ON SCHEMA chatbot FROM PUBLIC, anon, authenticated;

CREATE TABLE chatbot.documents (
  entity text NOT NULL CHECK (entity IN ('campaignAccesses','customers','opportunities','conversations','messages','evaluations','events','tasks','rules')),
  id text NOT NULL,
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object' AND body->>'id' IS NOT NULL AND body->>'id' = id),
  position bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  PRIMARY KEY (entity,id)
);
CREATE UNIQUE INDEX chatbot_customer_phone ON chatbot.documents ((body->>'phone')) WHERE entity='customers';
CREATE UNIQUE INDEX chatbot_customer_email ON chatbot.documents ((body->>'email')) WHERE entity='customers';
CREATE UNIQUE INDEX chatbot_opportunity_conversation ON chatbot.documents ((body->>'opportunityId')) WHERE entity='conversations';
CREATE INDEX chatbot_document_order ON chatbot.documents (entity,position);
CREATE INDEX chatbot_conversation_messages ON chatbot.documents ((body->>'conversationId'),position) WHERE entity='messages';
CREATE INDEX chatbot_opportunity_documents ON chatbot.documents (entity,(body->>'opportunityId'),position);

CREATE TABLE chatbot.lead_sync_outbox (
  opportunity_id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version > 0),
  snapshot text NOT NULL CHECK (jsonb_typeof(snapshot::jsonb) = 'object'),
  snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^[0-9a-f]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  status text NOT NULL CHECK (status IN ('pending','sending','synced','dead')),
  next_attempt_at text NOT NULL,
  last_error_code text,
  updated_at text NOT NULL
);
CREATE INDEX chatbot_lead_sync_due ON chatbot.lead_sync_outbox (status,next_attempt_at);

ALTER TABLE chatbot.documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot.lead_sync_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA chatbot FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA chatbot FROM PUBLIC, anon, authenticated;

-- Reuse the existing server role without granting access to scoring tables.
GRANT USAGE ON SCHEMA chatbot TO lead_chatbot_writer;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA chatbot TO lead_chatbot_writer;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA chatbot TO lead_chatbot_writer;
CREATE POLICY chatbot_backend_documents ON chatbot.documents FOR ALL TO lead_chatbot_writer USING (true) WITH CHECK (true);
CREATE POLICY chatbot_backend_outbox ON chatbot.lead_sync_outbox FOR ALL TO lead_chatbot_writer USING (true) WITH CHECK (true);
