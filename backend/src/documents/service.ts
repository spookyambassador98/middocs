import * as Y from "yjs";
import { pool } from "../db/pool.js";
import type { DocumentSummary } from "../types.js";

function emptyYjsState(): Buffer {
  const doc = new Y.Doc();
  // Touch the shared type so the initial encoded state is well-formed for
  // y-quill's Y.Text binding on the frontend.
  doc.getText("quill");
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return Buffer.from(update);
}

export async function createDocument(ownerId: string, title: string): Promise<DocumentSummary> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const docResult = await client.query(
      `INSERT INTO documents (title, owner_id) VALUES ($1, $2)
       RETURNING id, title, owner_id, created_at, updated_at`,
      [title, ownerId]
    );
    const doc = docResult.rows[0];

    await client.query(
      `INSERT INTO document_state (document_id, state) VALUES ($1, $2)`,
      [doc.id, emptyYjsState()]
    );

    await client.query(
      `INSERT INTO document_access (user_id, document_id) VALUES ($1, $2)
       ON CONFLICT (user_id, document_id) DO UPDATE SET last_opened_at = now()`,
      [ownerId, doc.id]
    );

    await client.query("COMMIT");

    return {
      id: doc.id,
      title: doc.title,
      ownerId: doc.owner_id,
      ownerName: "", // filled in by caller's own user context when needed
      isOwner: true,
      updatedAt: doc.updated_at,
      createdAt: doc.created_at,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function listDocumentsForUser(userId: string): Promise<DocumentSummary[]> {
  const result = await pool.query(
    `SELECT d.id, d.title, d.owner_id, d.created_at, d.updated_at, u.name AS owner_name
     FROM document_access da
     JOIN documents d ON d.id = da.document_id
     JOIN users u ON u.id = d.owner_id
     WHERE da.user_id = $1
     ORDER BY d.updated_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({
    id: row.id,
    title: row.title,
    ownerId: row.owner_id,
    ownerName: row.owner_name,
    isOwner: row.owner_id === userId,
    updatedAt: row.updated_at,
    createdAt: row.created_at,
  }));
}

export async function getDocumentMeta(documentId: string): Promise<{ id: string; title: string; ownerId: string } | null> {
  const result = await pool.query(
    "SELECT id, title, owner_id FROM documents WHERE id = $1",
    [documentId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { id: row.id, title: row.title, ownerId: row.owner_id };
}

export async function recordAccess(userId: string, documentId: string): Promise<void> {
  await pool.query(
    `INSERT INTO document_access (user_id, document_id) VALUES ($1, $2)
     ON CONFLICT (user_id, document_id) DO UPDATE SET last_opened_at = now()`,
    [userId, documentId]
  );
}

export async function renameDocument(documentId: string, title: string): Promise<void> {
  await pool.query(
    "UPDATE documents SET title = $1, updated_at = now() WHERE id = $2",
    [title, documentId]
  );
}

export async function deleteDocument(documentId: string, ownerId: string): Promise<boolean> {
  const result = await pool.query(
    "DELETE FROM documents WHERE id = $1 AND owner_id = $2",
    [documentId, ownerId]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function loadDocumentState(documentId: string): Promise<Uint8Array | null> {
  const result = await pool.query(
    "SELECT state FROM document_state WHERE document_id = $1",
    [documentId]
  );
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
