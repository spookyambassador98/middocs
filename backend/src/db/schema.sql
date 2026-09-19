-- Mini Google Docs schema
-- Applied automatically by the postgres container on first init
-- (mounted at /docker-entrypoint-initdb.d/schema.sql), and also
-- runnable manually via `npm run migrate`.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  name          TEXT NOT NULL,
  color         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title      TEXT NOT NULL DEFAULT 'Untitled document',
  owner_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The full, current Yjs CRDT state for a document, as produced by
-- Y.encodeStateAsUpdate(ydoc). Overwritten (debounced) whenever the
-- in-memory document changes. Because Yjs updates are commutative and
-- idempotent, whichever backend instance last persisted still holds a
-- fully merged state as long as the Redis pub/sub fan-out delivered all
-- updates to it first.
CREATE TABLE IF NOT EXISTS document_state (
  document_id UUID PRIMARY KEY REFERENCES documents(id) ON DELETE CASCADE,
  state       BYTEA NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Tracks who has ever opened a document, so it shows up on their
-- dashboard even if they don't own it (anyone with the link + an
-- account can edit, like a Google Doc set to "anyone with the link").
CREATE TABLE IF NOT EXISTS document_access (
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id    UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  last_opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, document_id)
);

CREATE INDEX IF NOT EXISTS idx_document_access_user ON document_access(user_id);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
