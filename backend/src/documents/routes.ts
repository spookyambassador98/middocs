import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../auth/middleware.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import {
  createDocument,
  listDocumentsForUser,
  getDocumentMeta,
  recordAccess,
  renameDocument,
  deleteDocument,
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

const createSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
});

documentsRouter.post(
  "/",
  asyncHandler(async (req, res) => {
    const parsed = createSchema.safeParse(req.body ?? {});
    const title = parsed.success && parsed.data.title ? parsed.data.title : "Untitled document";
    const doc = await createDocument(req.user!.id, title);
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

const renameSchema = z.object({
  title: z.string().trim().min(1).max(200),
});

documentsRouter.patch(
  "/:id",
  asyncHandler(async (req, res) => {
    const meta = await getDocumentMeta(req.params.id);
    if (!meta) {
      res.status(404).json({ error: "Document not found" });
      return;
    }
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "A non-empty title is required" });
      return;
    }
    await renameDocument(meta.id, parsed.data.title);
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
