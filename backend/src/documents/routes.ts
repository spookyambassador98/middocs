import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getRoomManager } from "../realtime/bridge.js";
import {
  createDocument,
  listDocumentsForUser,
  getDocumentMeta,
  recordAccess,
  renameDocument,
  setDocumentIcon,
  deleteDocument,
  listSnapshots,
  getSnapshotState,
  listUpdateLog,
  getAllUpdateBytes,
  listBranches,
  appendPendingUpdate,
  DEFAULT_DOC_ICON,
} from "./service.js";

export const documentsRouter = Router();
documentsRouter.use(requireAuth);

documentsRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const docs = await listDocumentsForUser(req.user!.id);
    res.json({ documents: docs });
  })
);

const createSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    icon: z.string().trim().min(1).max(8).optional(),
    encrypted: z.boolean().optional(),
    // Base64 ciphertext of a fresh empty Yjs state, produced client-side —
    // only the client can produce this since only it holds the key. See
    // service.ts's createDocument for why the server can't fall back to
    // generating its own baseline when this is missing.
    initialState: z.string().optional(),
  })
  .refine((data) => !data.encrypted || Boolean(data.initialState), {
    message: "initialState is required when creating an encrypted document",
  });

documentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    const title = parsed.data.title ?? "Untitled document";
    const icon = parsed.data.icon ?? DEFAULT_DOC_ICON;
    const doc = await createDocument(req.user!.id, title, icon, {
      encrypted: parsed.data.encrypted,
      initialState: parsed.data.initialState ? Buffer.from(parsed.data.initialState, "base64") : undefined,
    });
    res.status(201).json({ document: { ...doc, ownerName: req.user!.name } });
  })
);

documentsRouter.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    await recordAccess(req.user!.id, meta.id);
    res.json({ document: meta });
  })
);

const updateSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    icon: z.string().trim().min(1).max(8).optional(),
  })
  .refine((data) => data.title !== undefined || data.icon !== undefined, {
    message: "Provide a title and/or an icon to update",
  });

documentsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid input" });
      return;
    }
    if (parsed.data.title !== undefined) await renameDocument(meta.id, parsed.data.title);
    if (parsed.data.icon !== undefined) await setDocumentIcon(meta.id, parsed.data.icon);
    res.json({ ok: true });
  })
);

documentsRouter.delete(
  "/:id",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (meta.ownerId !== req.user!.id) {
      res.status(403).json({ error: "Only the owner can delete this document" });
      return;
    }
    await deleteDocument(meta.id, req.user!.id);
    res.json({ ok: true });
  })
);

// ---------- Version history ----------

documentsRouter.get(
  "/:id/history",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const snapshots = await listSnapshots(meta.id);
    res.json({ snapshots });
  })
);

documentsRouter.get(
  "/:id/history/:snapshotId",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const state = await getSnapshotState(meta.id, req.params.snapshotId);
    if (!state) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }
    res.json({ state: Buffer.from(state).toString("base64") });
  })
);

documentsRouter.post(
  "/:id/history/:snapshotId/restore",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    if (meta.encrypted) {
      res.status(400).json({ error: "Encrypted documents restore client-side — see HistoryDrawer.tsx" });
      return;
    }
    const state = await getSnapshotState(meta.id, req.params.snapshotId);
    if (!state) {
      res.status(404).json({ error: "Snapshot not found" });
      return;
    }
    // Applies as a live CRDT transaction on whichever instance currently
    // (or lazily now) holds the room in memory, and broadcasts to every
    // connected client through the normal sync pipeline — see
    // roomManager.restoreFromSnapshot for why this is safe.
    await getRoomManager().restoreFromSnapshot(meta.id, state);
    res.json({ ok: true });
  })
);

// ---------- Operation-level timelapse ----------

documentsRouter.get(
  "/:id/timelapse",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const ops = await listUpdateLog(meta.id);
    res.json({ ops });
  })
);

documentsRouter.get(
  "/:id/timelapse/updates",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const updates = await getAllUpdateBytes(meta.id);
    res.json({ updates: updates.map((u) => Buffer.from(u).toString("base64")) });
  })
);

// ---------- Zero-knowledge state access (branching & merge preview) ----------
// The server hands out whatever bytes it has without ever decoding them —
// see roomManager.getCurrentStateParts. What the caller does with them
// (decrypt, decode, diff, merge) all happens in the browser.

documentsRouter.get(
  "/:id/state",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const parts = await getRoomManager().getCurrentStateParts(meta.id);
    res.json({
      encrypted: meta.encrypted,
      baseline: parts.baseline ? Buffer.from(parts.baseline).toString("base64") : null,
      pending: parts.pending.map((u) => Buffer.from(u).toString("base64")),
    });
  })
);

// ---------- Branching ----------

documentsRouter.get(
  "/:id/branches",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const branches = await listBranches(meta.id);
    res.json({ branches });
  })
);

documentsRouter.post(
  "/:id/branch",
  asyncHandler(async (req, res) => {
    const parent = await getDocumentMeta(req.params.id);
    if (!parent) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const parts = await getRoomManager().getCurrentStateParts(parent.id);
    if (!parts.baseline) {
      res.status(409).json({ error: "Document has no content to fork yet" });
      return;
    }
    // A branch is just an ordinary new document — own room, own history,
    // own comments — seeded with a byte-for-byte copy of the parent's
    // current state. The server never needs to (and for an encrypted
    // parent, cannot) understand that content to copy it; if the parent is
    // encrypted the branch inherits the same flag and is only readable
    // with the same key (the branch's URL must carry the same #key
        // fragment as the parent's — the frontend handles that).
    const branch = await createDocument(req.user!.id, `${parent.title} (branch)`, parent.icon, {
      encrypted: parent.encrypted,
      forkedFromDocumentId: parent.id,
      initialState: Buffer.from(parts.baseline),
    });
    for (const pendingUpdate of parts.pending) {
      await appendPendingUpdate(branch.id, pendingUpdate);
    }
    res.status(201).json({ document: { ...branch, ownerName: req.user!.name } });
  })
);

// Deliberately no server-side "/merge" endpoint: merging a branch into a
// target document turns out to need nothing more than the browser calling
// Y.applyUpdate(targetDoc, branchStateBytes) on its own already-open live
// document — Yjs computes exactly the novel operations that weren't
// already there and that update flows through the *normal* edit pipeline
// (encrypt-if-needed, send, persist, broadcast) automatically, the same
// path a keystroke takes. See BranchMergeModal.tsx. roomManager still
// exposes mergeExternalState() for a server-driven merge without any
// client connected, kept for API completeness, but nothing here calls it.
