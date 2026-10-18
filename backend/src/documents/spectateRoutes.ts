import { Router } from "express";
import { asyncHandler } from "../utils/asyncHandler.js";
import { getDocumentBySpectatorToken } from "./service.js";

// Deliberately its own router, mounted at /api/spectate WITHOUT
// requireAuth (see index.ts) — a "watch live" link is meant to work for
// someone with no account at all. All it hands back is display metadata
// (title/icon); the actual live content only ever reaches a socket that
// presents the same token to "join-spectate" (see realtime/socket.ts),
// and only for a document that isn't zero-knowledge (routes.ts refuses to
// mint a spectator token for an encrypted document in the first place).
export const spectateRouter = Router();

spectateRouter.get(
  "/:token",
  asyncHandler(async (req, res) => {
    const doc = await getDocumentBySpectatorToken(req.params.token);
    if (!doc || doc.encrypted) {
      res.status(404).json({ error: "This watch link doesn't exist or is no longer active" });
      return;
    }
    res.json({ documentId: doc.id, title: doc.title, icon: doc.icon });
  })
);
