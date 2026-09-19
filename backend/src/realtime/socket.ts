import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { config } from "../config.js";
import { verifyToken } from "../auth/utils.js";
import { getDocumentMeta, recordAccess } from "../documents/service.js";
import { createBus } from "./bus.js";
import { createRoomManager, roomName } from "./roomManager.js";
import type { AuthUser } from "../types.js";

declare module "socket.io" {
  interface SocketData {
    user: AuthUser;
    docId?: string;
    awarenessClientId?: number;
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

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) {
      next(new Error("Missing auth token"));
      return;
    }
    try {
      const payload = verifyToken(token);
      socket.data.user = { id: payload.sub, email: payload.email, name: payload.name, color: payload.color };
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;

    socket.on("join-document", async ({ docId, awarenessClientId }: { docId: string; awarenessClientId: number }, ack) => {
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
        recordAccess(user.id, docId).catch((err) => console.error("[access] failed to record", err));

        const stateUpdate = Y.encodeStateAsUpdate(room.doc);
        const awarenessStates = Array.from(room.awareness.getStates().keys());
        const awarenessUpdate = awarenessProtocol.encodeAwarenessUpdate(room.awareness, awarenessStates);

        ack?.({
          ok: true,
          title: meta.title,
          ownerId: meta.ownerId,
          state: Buffer.from(stateUpdate),
          awareness: Buffer.from(awarenessUpdate),
        });
      } catch (err) {
        console.error("[join-document] failed", err);
        ack?.({ ok: false, error: "Failed to join document" });
      }
    });

    socket.on("sync-update", ({ docId, update }: { docId: string; update: ArrayBuffer | Uint8Array }) => {
      const room = roomManager.rooms.get(docId);
      if (!room || socket.data.docId !== docId) return;
      Y.applyUpdate(room.doc, toUint8Array(update), `local:${socket.id}`);
    });

    socket.on("awareness-update", ({ docId, update }: { docId: string; update: ArrayBuffer | Uint8Array }) => {
      const room = roomManager.rooms.get(docId);
      if (!room || socket.data.docId !== docId) return;
      awarenessProtocol.applyAwarenessUpdate(room.awareness, toUint8Array(update), `local:${socket.id}`);
    });

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
