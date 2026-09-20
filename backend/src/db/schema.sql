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
  icon       TEXT NOT NULL DEFAULT '📄',
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

-- Append-only checkpoints of a document's full Yjs state, taken
-- periodically while it's being edited (see roomManager's
-- SNAPSHOT_INTERVAL_MS) plus one at creation. Powers the "time travel"
-- version history UI: unlike document_state (the single current state,
-- overwritten in place), this table keeps every checkpoint so the client
-- can scrub backwards and preview or restore an older revision.
CREATE TABLE IF NOT EXISTS document_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  state       BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_snapshots_doc ON document_snapshots(document_id, created_at DESC);

-- Every individual Yjs update, kept forever (unlike document_snapshots'
-- periodic checkpoints). Powers the operation-level "timelapse" replay:
-- scrubbing through the *exact* sequence of edits rather than jumping
-- between a handful of checkpoints. For an encrypted document the bytes
-- here are ciphertext, same as everywhere else this app stores Yjs state
-- — the server never needs to (and cannot) read them.
-- Known scaling trade-off, documented in README: this grows without bound
-- for a document that's never pruned. Fine for a portfolio project; a
-- production system would want periodic compaction (e.g. drop updates
-- older than the oldest snapshot a user could still want to scrub to).
CREATE TABLE IF NOT EXISTS document_updates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  update      BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_updates_doc ON document_updates(document_id, created_at ASC);

-- Encrypted-document relay log. For a zero-knowledge document the server
-- never holds a decoded Y.Doc (it cannot decrypt the content), so it
-- can't merge concurrent updates into one compacted state the way it does
-- for a plaintext document's document_state row. Instead every encrypted
-- update is appended here (ciphertext, opaque to the server) until the
-- client itself pushes an explicit "checkpoint" (its own locally-merged
-- full state, re-encrypted) — at that point the server treats the
-- checkpoint as the new document_state baseline and clears this table for
-- that document. A late-joining client bootstraps by decrypting the
-- baseline plus every row still queued here, in order.
CREATE TABLE IF NOT EXISTS document_pending_updates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  update      BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_pending_updates_doc ON document_pending_updates(document_id, created_at ASC);

-- Safe to re-run: if you already had this schema applied from before the
-- `icon` column existed, this brings an existing Postgres volume up to
-- date without needing to drop it. `npm run migrate` re-applies this
-- whole file.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT '📄';

-- Zero-knowledge mode: when true, the server only ever sees ciphertext for
-- this document's content (text, title stays in the encrypted Yjs "meta"
-- map — see README's "Zero-knowledge documents" section for what stays
-- outside that boundary, like presence metadata). The decryption key
-- lives only in the URL fragment, which browsers never send to a server.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS encrypted BOOLEAN NOT NULL DEFAULT false;

-- Set when a document was created via "Fork as branch" from another one.
-- A branch is a completely ordinary document (own room, own history, own
-- comments) whose initial document_state/document_snapshots row was
-- seeded by copying the parent's current state bytes verbatim — the
-- server never needs to decode them to do that, so this works identically
-- for encrypted and plaintext documents.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS forked_from_document_id UUID REFERENCES documents(id) ON DELETE SET NULL;
