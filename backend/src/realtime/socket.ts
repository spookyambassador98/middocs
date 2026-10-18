import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { config } from "../config.js";
import { verifyToken } from "../auth/utils.js";
import { getDocumentMeta, getDocumentBySpectatorToken, recordAccess } from "../documents/service.js";
import { createBus } from "./bus.js";
import { createRoomManager, roomName, type Room } from "./roomManager.js";
import { setRoomManager } from "./bridge.js";
import type { AuthUser } from "../types.js";

declare module "socket.io" {
  interface Socket {
    data: {
      // Present for a real, logged-in editor; absent for a spectator.
      user?: AuthUser;
      docId?: string;
      awarenessClientId?: number;
      // A public, no-login "watch live" connection — see join-spectate
      // below and schema.sql's spectator_token column. Every mutating
      // event handler checks this flag first and refuses to do anything.
      spectator?: boolean;
      spectatorToken?: string;
    };
  }
}

function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export async function attachRealtime(httpServer: HttpServer) {
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigin, credentials: true },
    // Keep both transports: polling first for maximum compatibility behind
    // proxies, upgrading to a WebSocket once the handshake completes.
  });

  // --- Socket.io Redis adapter -------------------------------------------------
  // Lets io.to(room).emit(...) reach sockets connected to *any* backend
  // instance, not just this process. This is what actually makes the app
  // horizontally scalable at the transport level.
  const pubClient = createClient({ url: config.redisUrl });
  const subClient = pubClient.duplicate();
  await Promise.all([pubClient.connect(), subClient.connect()]);
  io.adapter(createAdapter(pubClient, subClient));

  // --- Application-level Redis bus --------------------------------------------
  // Keeps every instance's in-memory Yjs state (documents + awareness)
  // consistent with the others. See bus.ts for why this is separate from
  // the adapter above.
  const bus = await createBus((docId, type, payload) => {
    roomManager.applyRemoteUpdate(docId, type, payload);
  });

  const roomManager = createRoomManager(io, bus.publish);
  setRoomManager(roomManager);

  // Shared by join-document and join-spectate: the encrypted-vs-plaintext
  // branching for "what state do I hand a freshly-joined socket" is
  // identical for a real editor and a read-only spectator — the only
  // difference between the two join paths is what happens *after* (a
  // spectator is never registered for authorship/presence, and can never
  // send anything back).
  function buildStateAndAwarenessPayload(room: Room): {
    encrypted: boolean;
    state: Buffer | null;
    pendingUpdates?: Buffer[];
    awareness: Buffer;
  } {
    const awarenessStates = Array.from(room.awareness.getStates().keys());
    const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(room.awareness, awarenessStates);
    if (room.encrypted) {
      // The server never decodes an encrypted room's content, so it can't
      // hand back one merged state the way it does below — instead: the
      // last client-pushed checkpoint (may be null only in the narrow
      // window right after creation) plus every encrypted update since, in
      // order. The client decrypts each and applies them in turn to
      // reconstruct current content locally.
      return {
        encrypted: true,
        state: room.latestCipherState ? Buffer.from(room.latestCipherState) : null,
        pendingUpdates: room.pendingCipherUpdates.map((u) => Buffer.from(u)),
        awareness: Buffer.from(awarenessUpdate),
      };
    }
    return {
      encrypted: false,
      state: Buffer.from(Y.encodeStateAsUpdate(room.doc)),
      awareness: Buffer.from(awarenessUpdate),
    };
  }

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    const spectatorToken = socket.handshake.auth?.spectatorToken as string | undefined;

    if (token) {
      try {
        const payload = verifyToken(token);
        socket.data.user = { id: payload.sub, email: payload.email, name: payload.name, color: payload.color };
        next();
      } catch {
        next(new Error("Invalid or expired token"));
      }
      return;
    }

    if (spectatorToken && typeof spectatorToken === "string") {
      // Whether this token still actually maps to a document is checked
      // once, authoritatively, inside "join-spectate" below — a spectator
      // connection is allowed to *exist* with just a non-empty token; it
      // just won't be able to join any room without a valid one.
      socket.data.spectator = true;
      socket.data.spectatorToken = spectatorToken;
      next();
      return;
    }

    next(new Error("Missing auth token"));
  });

  io.on("connection", (socket) => {
    socket.on("join-document", async ({ docId, awarenessClientId }: { docId: string; awarenessClientId: number }, ack) => {
      const user = socket.data.user;
      if (!user) {
        ack?.({ ok: false, error: "Unauthorized" });
        return;
      }
      try {
        const meta = await getDocumentMeta(docId);
        if (!meta) {
          ack?.({ ok: false, error: "Document not found" });
          return;
        }

        socket.data.docId = docId;
        socket.data.awarenessClientId = awarenessClientId;
        await socket.join(roomName(docId));

        const room = await roomManager.acquire(docId);
        roomManager.registerSocketPresence(docId, socket.id, awarenessClientId, user);
        recordAccess(user.id, docId).catch((err) => console.error("[access] failed to record", err));

        const payload = buildStateAndAwarenessPayload(room);
        ack?.({ ok: true, title: meta.title, ownerId: meta.ownerId, ...payload });
      } catch (err) {
        console.error("[join-document] failed", err);
        ack?.({ ok: false, error: "Failed to join document" });
      }
    });

    // A public, no-login, read-only connection — see schema.sql's
    // spectator_token and the module comment above buildStateAndAwarenessPayload.
    // Deliberately its own event rather than reusing "join-document" with a
    // flag: keeping the two paths textually separate makes it obvious by
    // inspection that a spectator socket is never handed anything a real
    // editor's socket wouldn't also get, and — more importantly — is never
    // wired into any of the mutating handlers below.
    socket.on("join-spectate", async ({ token }: { token: string }, ack) => {
      if (!socket.data.spectator || socket.data.spectatorToken !== token) {
        ack?.({ ok: false, error: "Invalid spectator token" });
        return;
      }
      try {
        const meta = await getDocumentBySpectatorToken(token);
        if (!meta) {
          ack?.({ ok: false, error: "This watch link is no longer active" });
          return;
        }

        socket.data.docId = meta.id;
        await socket.join(roomName(meta.id));
        const room = await roomManager.acquire(meta.id);
        // Deliberately NOT registerSocketPresence: a spectator contributes
        // no authorship, no WebRTC mesh membership, and no awareness
        // identity of its own — it only ever receives.
        const payload = buildStateAndAwarenessPayload(room);
        ack?.({ ok: true, title: meta.title, icon: meta.icon, ...payload });
      } catch (err) {
        console.error("[join-spectate] failed", err);
        ack?.({ ok: false, error: "Failed to join" });
      }
    });

    socket.on("sync-update", ({ docId, update }: { docId: string; update: ArrayBuffer | Uint8Array }) => {
      if (socket.data.spectator || socket.data.docId !== docId) return;
      roomManager.applyClientUpdate(docId, socket.id, toUint8Array(update));
    });

    // Encrypted documents only: the client's own locally-merged full
    // state, re-encrypted, replacing the accumulated pending-update log
    // with one compact baseline. See roomManager's module comment.
    socket.on("checkpoint", ({ docId, state }: { docId: string; state: ArrayBuffer | Uint8Array }) => {
      if (socket.data.spectator || socket.data.docId !== docId) return;
      void roomManager.applyCheckpoint(docId, socket.id, toUint8Array(state));
    });

    socket.on("awareness-update", ({ docId, update }: { docId: string; update: ArrayBuffer | Uint8Array }) => {
      if (socket.data.spectator) return;
      const room = roomManager.rooms.get(docId);
      if (!room || socket.data.docId !== docId) return;
      awarenessProtocol.applyAwarenessUpdate(room.awareness, toUint8Array(update), `local:${socket.id}`);
    });

    // Ephemeral, fire-and-forget: not part of the Yjs document at all, so
    // no persistence and no application-level Redis bus needed. The
    // Socket.io Redis adapter alone already makes io.to(room).emit(...)
    // reach clients on every backend instance, which is all this needs.
    socket.on("reaction", ({ docId, emoji }: { docId: string; emoji: string }) => {
      if (socket.data.spectator || socket.data.docId !== docId) return;
      if (typeof emoji !== "string" || emoji.length === 0 || emoji.length > 8) return;
      io.to(roomName(docId)).emit("reaction", {
        emoji,
        clientId: socket.data.awarenessClientId,
      });
    });

    // Also ephemeral, same reasoning as "reaction" above: powers the live
    // per-character attribution heatmap (Editor.tsx / AttributionOverlay),
    // not part of the CRDT document itself, so a peer who was offline for
    // the moment it fired simply never sees that highlight — acceptable
    // for a purely visual, self-fading affordance.
    socket.on("attribution", ({ docId, index, length }: { docId: string; index: number; length: number }) => {
      if (socket.data.spectator || socket.data.docId !== docId) return;
      if (typeof index !== "number" || typeof length !== "number" || length <= 0 || length > 20_000) return;
      io.to(roomName(docId)).emit("attribution", {
        index,
        length,
        clientId: socket.data.awarenessClientId,
      });
    });

    // Pure signaling relay for the peer-to-peer WebRTC mesh (see
    // frontend/src/editor/webrtcMesh.ts): the server never looks at
    // `signal`'s contents (an SDP offer/answer or an ICE candidate), it
    // just forwards it to whichever socket currently owns that awareness
    // clientID in this room — the same "dumb relay" role the server plays
    // for an encrypted document's ciphertext, just for connection
    // negotiation instead of content. Once the resulting RTCDataChannel is
    // open, actual Yjs sync bytes flow directly between browsers, not
    // through this relay at all.
    socket.on(
      "webrtc-signal",
      ({ docId, toClientId, signal }: { docId: string; toClientId: number; signal: unknown }) => {
        if (socket.data.spectator || socket.data.docId !== docId) return;
        const targetSocketId = roomManager.getSocketIdForClient(docId, toClientId);
        if (!targetSocketId) return;
        io.to(targetSocketId).emit("webrtc-signal", {
          fromClientId: socket.data.awarenessClientId,
          signal,
        });
      }
    );

    socket.on("leave-document", () => {
      cleanupSocket();
    });

    socket.on("disconnect", () => {
      cleanupSocket();
    });

    function cleanupSocket() {
      const docId = socket.data.docId;
      const clientId = socket.data.awarenessClientId;
      if (docId === undefined) return;
      if (!socket.data.spectator) {
        roomManager.unregisterSocketPresence(docId, socket.id);
      }
      if (clientId !== undefined) {
        roomManager.removeAwarenessClient(docId, clientId);
      }
      roomManager.release(docId);
      socket.data.docId = undefined;
      socket.data.awarenessClientId = undefined;
    }
  });

  async function shutdown() {
    await roomManager.flushAll();
    await bus.close();
    io.close();
  }

  return { io, shutdown };
}
