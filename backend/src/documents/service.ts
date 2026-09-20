import * as Y from "yjs";
import { pool } from "../db/pool.js";
import type { DocumentSummary } from "../types.js";

export const DEFAULT_DOC_ICON = "📄";

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
  try {
    await client.query("BEGIN");
    const docResult = await client.query(
      `INSERT INTO documents (title, icon, owner_id, encrypted, forked_from_document_id)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, title, icon, owner_id, created_at, updated_at, encrypted, forked_from_document_id`,
      [title, icon || DEFAULT_DOC_ICON, ownerId, Boolean(options?.encrypted), options?.forkedFromDocumentId ?? null]
    );
    const doc = docResult.rows[0];
    const initialState = options?.initialState ?? emptyYjsState();

    await client.query(`INSERT INTO document_state (document_id, state) VALUES ($1, $2)`, [doc.id, initialState]);

    // A baseline snapshot so the version history timeline has a starting
    // point even before the first debounced checkpoint fires.
    await client.query(`INSERT INTO document_snapshots (document_id, state) VALUES ($1, $2)`, [doc.id, initialState]);

    await client.query(
      `INSERT INTO document_access (user_id, document_id) VALUES ($1, $2)
       ON CONFLICT (user_id, document_id) DO UPDATE SET last_opened_at = now()`,
      [ownerId, doc.id]
    );

    await client.query("COMMIT");

    return mapDocumentRow(doc, ownerId);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listDocumentsForUser(userId: string): Promise<DocumentSummary[]> {
  const result = await pool.query(
    `SELECT d.id, d.title, d.icon, d.owner_id, d.created_at, d.updated_at, d.encrypted,
            d.forked_from_document_id, u.name AS owner_name
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
} | null> {
  const result = await pool.query(
    "SELECT id, title, icon, owner_id, encrypted, forked_from_document_id FROM documents WHERE id = $1",
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

export async function insertSnapshot(documentId: string, state: Uint8Array): Promise<void> {
  await pool.query(`INSERT INTO document_snapshots (document_id, state) VALUES ($1, $2)`, [
    documentId,
    Buffer.from(state),
  ]);
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

export async function insertUpdateLog(documentId: string, update: Uint8Array): Promise<void> {
  await pool.query(`INSERT INTO document_updates (document_id, update) VALUES ($1, $2)`, [
    documentId,
    Buffer.from(update),
  ]);
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
