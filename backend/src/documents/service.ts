import * as Y from "yjs";
import { createHash, randomBytes } from "node:crypto";
import { pool } from "../db/pool.js";
import type { DocumentSummary } from "../types.js";

export const DEFAULT_DOC_ICON = "📄";

// ---------- Notary: hash-chain primitives ----------
// See schema.sql's comment on document_snapshots for the full picture.
// GENESIS_HASH is the "previous hash" a document's very first snapshot
// chains to — the same idea as git's empty tree, or a blockchain's genesis
// block, just spelled out as 64 zero characters (the same length as a
// real sha256 hex digest) so the chain is uniform from entry zero.
const GENESIS_HASH = "0".repeat(64);

function sha256Hex(data: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function emptyYjsState(): Buffer {
  const doc = new Y.Doc();
  // Touch the shared type so the initial encoded state is well-formed for
  // y-quill's Y.Text binding on the frontend.
  doc.getText("quill");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return Buffer.from(update);
}

function mapDocumentRow(row: {
  id: string;
  title: string;
  icon: string;
  owner_id: string;
  owner_name?: string;
  created_at: string;
  updated_at: string;
  encrypted: boolean;
  forked_from_document_id: string | null;
  spectator_token: string | null;
}, viewerId: string): DocumentSummary {
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    ownerId: row.owner_id,
    ownerName: row.owner_name ?? "",
    isOwner: row.owner_id === viewerId,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
    encrypted: row.encrypted,
    forkedFromDocumentId: row.forked_from_document_id,
    spectatorToken: row.spectator_token,
  };
}

/**
 * Creates a document. `initialState` lets a caller seed the Yjs state at
 * creation time instead of getting a fresh empty document:
 *  - Forking a branch passes the parent's current state bytes verbatim
 *    (opaque either way — plaintext or ciphertext — since this is a raw
 *    byte copy, never decoded).
 *  - Creating a *new* zero-knowledge document passes the client's own
 *    encrypted empty-doc baseline, because only the client holds the key
 *    needed to produce it; the server has no way to encrypt one itself.
 */
export async function createDocument(
  ownerId: string,
  title: string,
  icon?: string,
  options?: { encrypted?: boolean; forkedFromDocumentId?: string; initialState?: Buffer }
): Promise<DocumentSummary> {
  const client = await pool.connect();
  let doc: { id: string; title: string; icon: string; owner_id: string; created_at: string; updated_at: string; encrypted: boolean; forked_from_document_id: string | null; spectator_token: string | null };
  let initialState: Buffer;
  try {
    await client.query("BEGIN");
    const docResult = await client.query(
      `INSERT INTO documents (title, icon, owner_id, encrypted, forked_from_document_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, icon, owner_id, created_at, updated_at, encrypted, forked_from_document_id, spectator_token`,
      [title, icon || DEFAULT_DOC_ICON, ownerId, Boolean(options?.encrypted), options?.forkedFromDocumentId ?? null]
    );
    doc = docResult.rows[0];
    initialState = options?.initialState ?? emptyYjsState();

    await client.query(`INSERT INTO document_state (document_id, state) VALUES ($1, $2)`, [doc.id, initialState]);

    await client.query(
      `INSERT INTO document_access (user_id, document_id) VALUES ($1, $2)
       ON CONFLICT (user_id, document_id) DO UPDATE SET last_opened_at = now()`,
      [ownerId, doc.id]
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Outside the transaction, once the document id is durably committed: the
  // genesis entry of its notary hash-chain (see insertSnapshot below), and
  // also the version-history timeline's starting point even before the
  // first debounced checkpoint fires. A brand-new document can have no
  // prior snapshot, so its "previous hash" is always GENESIS_HASH — that's
  // true regardless of transaction timing, so doing this just after commit
  // (rather than inside the transaction) is safe.
  await insertSnapshot(
    doc.id,
    initialState,
    options?.forkedFromDocumentId ? "Forked the document" : "Created the document"
  );

  return mapDocumentRow(doc, ownerId);
}

export async function listDocumentsForUser(userId: string): Promise<DocumentSummary[]> {
  const result = await pool.query(
    `SELECT d.id, d.title, d.icon, d.owner_id, d.created_at, d.updated_at, d.encrypted,
            d.forked_from_document_id, d.spectator_token, u.name AS owner_name
     FROM document_access da
     JOIN documents d ON d.id = da.document_id
     JOIN users u ON u.id = d.owner_id
     WHERE da.user_id = $1
     ORDER BY d.updated_at DESC`,
    [userId]
  );
  return result.rows.map((row) => mapDocumentRow(row, userId));
}

export async function getDocumentMeta(documentId: string): Promise<{
  id: string;
  title: string;
  icon: string;
  ownerId: string;
  encrypted: boolean;
  forkedFromDocumentId: string | null;
  spectatorToken: string | null;
} | null> {
  const result = await pool.query(
    "SELECT id, title, icon, owner_id, encrypted, forked_from_document_id, spectator_token FROM documents WHERE id = $1",
    [documentId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    icon: row.icon,
    ownerId: row.owner_id,
    encrypted: row.encrypted,
    forkedFromDocumentId: row.forked_from_document_id,
    spectatorToken: row.spectator_token,
  };
}

export async function recordAccess(userId: string, documentId: string): Promise<void> {
  await pool.query(
    `INSERT INTO document_access (user_id, document_id) VALUES ($1, $2)
     ON CONFLICT (user_id, document_id) DO UPDATE SET last_opened_at = now()`,
    [userId, documentId]
  );
}

export async function renameDocument(documentId: string, title: string): Promise<void> {
  await pool.query("UPDATE documents SET title = $1, updated_at = now() WHERE id = $2", [title, documentId]);
}

export async function setDocumentIcon(documentId: string, icon: string): Promise<void> {
  await pool.query("UPDATE documents SET icon = $1, updated_at = now() WHERE id = $2", [icon, documentId]);
}

export async function deleteDocument(documentId: string, ownerId: string): Promise<boolean> {
  const result = await pool.query("DELETE FROM documents WHERE id = $1 AND owner_id = $2", [documentId, ownerId]);
  return (result.rowCount ?? 0) > 0;
}

export async function loadDocumentState(documentId: string): Promise<Uint8Array | null> {
  const result = await pool.query("SELECT state FROM document_state WHERE document_id = $1", [documentId]);
  const row = result.rows[0];
  if (!row) return null;
  return new Uint8Array(row.state);
}

export async function saveDocumentState(documentId: string, state: Uint8Array): Promise<void> {
  await pool.query(
    `INSERT INTO document_state (document_id, state, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (document_id) DO UPDATE SET state = $2, updated_at = now()`,
    [documentId, Buffer.from(state)]
  );
  await pool.query("UPDATE documents SET updated_at = now() WHERE id = $1", [documentId]);
}

// ---------- Version history (periodic checkpoints) ----------

export interface SnapshotSummary {
  id: string;
  createdAt: string;
}

async function getLatestChainHash(documentId: string): Promise<string> {
  const result = await pool.query(
    "SELECT chain_hash FROM document_snapshots WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1",
    [documentId]
  );
  return result.rows[0]?.chain_hash ?? GENESIS_HASH;
}

/**
 * Inserts a snapshot AND extends the document's notary hash-chain in the
 * same call — every caller of this function (document creation, forking,
 * roomManager's periodic checkpoints and encrypted "checkpoint" pushes)
 * gets chain integrity for free, with no separate step to forget. See
 * schema.sql's comment on document_snapshots for exactly what's hashed
 * and why; `authorSummary` is a plain display string (e.g. "Иван, Мария"
 * or "Создание документа"), never anything that needs its own integrity
 * protection — it's part of what's *chained*, so tampering with it after
 * the fact would break the hash from that point forward.
 */
export async function insertSnapshot(documentId: string, state: Uint8Array, authorSummary: string | null = null): Promise<void> {
  const prevHash = await getLatestChainHash(documentId);
  const createdAt = new Date();
  const buf = Buffer.from(state);
  const stateHash = sha256Hex(buf);
  const chainHash = sha256Hex(`${prevHash}:${documentId}:${createdAt.toISOString()}:${authorSummary ?? ""}:${stateHash}`);

  await pool.query(
    `INSERT INTO document_snapshots (document_id, state, created_at, prev_chain_hash, chain_hash, state_hash, author_summary)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [documentId, buf, createdAt, prevHash, chainHash, stateHash, authorSummary]
  );
}

export interface NotaryEntry {
  id: string;
  createdAt: string;
  prevChainHash: string | null;
  chainHash: string | null;
  stateHash: string | null;
  authorSummary: string | null;
}

/**
 * The full chain for a document, oldest first, as plain metadata — no
 * actual document bytes are ever included, so this is cheap to fetch and
 * safe to hand to a browser that then recomputes and verifies every link
 * itself (see frontend/src/editor/notary.ts). Rows from before this
 * feature existed (an older Postgres volume upgraded via `npm run
 * migrate`) have null chain_hash/state_hash — the frontend treats those as
 * "predates the notary" rather than as a broken link.
 */
export async function listNotaryChain(documentId: string): Promise<NotaryEntry[]> {
  const result = await pool.query(
    `SELECT id, created_at, prev_chain_hash, chain_hash, state_hash, author_summary
     FROM document_snapshots WHERE document_id = $1 ORDER BY created_at ASC`,
    [documentId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    prevChainHash: row.prev_chain_hash,
    chainHash: row.chain_hash,
    stateHash: row.state_hash,
    authorSummary: row.author_summary,
  }));
}

export async function getLatestSnapshotTime(documentId: string): Promise<number | null> {
  const result = await pool.query(
    "SELECT created_at FROM document_snapshots WHERE document_id = $1 ORDER BY created_at DESC LIMIT 1",
    [documentId]
  );
  const row = result.rows[0];
  return row ? new Date(row.created_at).getTime() : null;
}

export async function listSnapshots(documentId: string): Promise<SnapshotSummary[]> {
  const result = await pool.query(
    "SELECT id, created_at FROM document_snapshots WHERE document_id = $1 ORDER BY created_at ASC",
    [documentId]
  );
  return result.rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
}

export async function getSnapshotState(documentId: string, snapshotId: string): Promise<Uint8Array | null> {
  const result = await pool.query("SELECT state FROM document_snapshots WHERE document_id = $1 AND id = $2", [
    documentId,
    snapshotId,
  ]);
  const row = result.rows[0];
  if (!row) return null;
  return new Uint8Array(row.state);
}

// ---------- Operation-level update log (timelapse) ----------

const TIMELAPSE_MAX_OPS = 4000;

export async function insertUpdateLog(
  documentId: string,
  update: Uint8Array,
  authorId?: string | null,
  authorName?: string | null
): Promise<void> {
  await pool.query(
    `INSERT INTO document_updates (document_id, update, author_id, author_name) VALUES ($1, $2, $3, $4)`,
    [documentId, Buffer.from(update), authorId ?? null, authorName ?? null]
  );
}

export interface TimelapseOp {
  id: string;
  createdAt: string;
}

export async function listUpdateLog(documentId: string): Promise<TimelapseOp[]> {
  const result = await pool.query(
    `SELECT id, created_at FROM document_updates WHERE document_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [documentId, TIMELAPSE_MAX_OPS]
  );
  return result.rows.map((row) => ({ id: row.id, createdAt: row.created_at }));
}

/** All logged update bytes for a document, in order — used to bulk-replay a timelapse. */
export async function getAllUpdateBytes(documentId: string): Promise<Uint8Array[]> {
  const result = await pool.query(
    `SELECT update FROM document_updates WHERE document_id = $1 ORDER BY created_at ASC LIMIT $2`,
    [documentId, TIMELAPSE_MAX_OPS]
  );
  return result.rows.map((row) => new Uint8Array(row.update));
}

// ---------- Encrypted-document relay log ----------
// See document_pending_updates in schema.sql: for a zero-knowledge
// document the server can't merge concurrent ciphertext updates into one
// compacted state itself, so it just queues them here until the client
// pushes an explicit checkpoint.

export async function appendPendingUpdate(documentId: string, update: Uint8Array): Promise<void> {
  await pool.query(`INSERT INTO document_pending_updates (document_id, update) VALUES ($1, $2)`, [
    documentId,
    Buffer.from(update),
  ]);
}

export async function listPendingUpdates(documentId: string): Promise<Uint8Array[]> {
  const result = await pool.query(
    `SELECT update FROM document_pending_updates WHERE document_id = $1 ORDER BY created_at ASC`,
    [documentId]
  );
  return result.rows.map((row) => new Uint8Array(row.update));
}

export async function clearPendingUpdates(documentId: string): Promise<void> {
  await pool.query(`DELETE FROM document_pending_updates WHERE document_id = $1`, [documentId]);
}

// ---------- Branching ----------

export async function listBranches(documentId: string): Promise<{ id: string; title: string; icon: string; createdAt: string }[]> {
  const result = await pool.query(
    `SELECT id, title, icon, created_at FROM documents WHERE forked_from_document_id = $1 ORDER BY created_at DESC`,
    [documentId]
  );
  return result.rows.map((row) => ({ id: row.id, title: row.title, icon: row.icon, createdAt: row.created_at }));
}

// ---------- Public "watch live" spectator links ----------

export function generateSpectatorToken(): string {
  return randomBytes(18).toString("base64url");
}

export async function setSpectatorToken(documentId: string, token: string | null): Promise<void> {
  await pool.query("UPDATE documents SET spectator_token = $1 WHERE id = $2", [token, documentId]);
}

export async function getDocumentBySpectatorToken(
  token: string
): Promise<{ id: string; title: string; icon: string; encrypted: boolean } | null> {
  const result = await pool.query(
    "SELECT id, title, icon, encrypted FROM documents WHERE spectator_token = $1",
    [token]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, title: row.title, icon: row.icon, encrypted: row.encrypted };
}

// ---------- Personal "Flow" activity analytics ----------
// Deliberately reads ONLY document_updates.created_at (never the document
// content, which for an encrypted document the server couldn't read
// anyway) — timestamps and a row count are all that's needed for an
// activity calendar and a "focus session" breakdown, so this works
// identically and with the same privacy boundary for encrypted and
// plaintext documents alike.

export interface ActivityDay {
  date: string; // YYYY-MM-DD, UTC
  ops: number;
}

export interface ActivitySession {
  start: string;
  end: string;
  opCount: number;
}

// A gap this long between two consecutive edits is treated as the end of
// one "focus session" and the start of a new one — the same heuristic
// GitHub-style coding-time trackers use.
const ACTIVITY_SESSION_GAP_MS = 5 * 60_000;
const ACTIVITY_MAX_ROWS = 50_000;
const ACTIVITY_MAX_SESSIONS = 80;

export async function getUserActivity(
  userId: string,
  days = 180
): Promise<{ daily: ActivityDay[]; sessions: ActivitySession[] }> {
  const result = await pool.query(
    `SELECT created_at FROM document_updates
     WHERE author_id = $1 AND created_at > now() - ($2 || ' days')::interval
     ORDER BY created_at ASC
     LIMIT $3`,
    [userId, String(days), ACTIVITY_MAX_ROWS]
  );
  const timestamps: number[] = result.rows.map((row) => new Date(row.created_at).getTime());

  const dailyMap = new Map<string, number>();
  for (const ts of timestamps) {
    const day = new Date(ts).toISOString().slice(0, 10);
    dailyMap.set(day, (dailyMap.get(day) ?? 0) + 1);
  }
  const daily: ActivityDay[] = Array.from(dailyMap.entries()).map(([date, ops]) => ({ date, ops }));

  const sessions: ActivitySession[] = [];
  let sessionStart: number | null = null;
  let sessionEnd: number | null = null;
  let sessionOps = 0;
  for (const ts of timestamps) {
    if (sessionStart === null || sessionEnd === null) {
      sessionStart = ts;
      sessionEnd = ts;
      sessionOps = 1;
      continue;
    }
    if (ts - sessionEnd > ACTIVITY_SESSION_GAP_MS) {
      sessions.push({ start: new Date(sessionStart).toISOString(), end: new Date(sessionEnd).toISOString(), opCount: sessionOps });
      sessionStart = ts;
      sessionEnd = ts;
      sessionOps = 1;
    } else {
      sessionEnd = ts;
      sessionOps += 1;
    }
  }
  if (sessionStart !== null && sessionEnd !== null) {
    sessions.push({ start: new Date(sessionStart).toISOString(), end: new Date(sessionEnd).toISOString(), opCount: sessionOps });
  }

  // Most recent sessions first, capped to keep the payload small.
  sessions.reverse();
  return { daily, sessions: sessions.slice(0, ACTIVITY_MAX_SESSIONS) };
}
