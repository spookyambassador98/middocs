import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import type { Server } from "socket.io";
import { config } from "../config.js";
import { loadDocumentState, saveDocumentState } from "../documents/service.js";

export interface Room {
  docId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  refCount: number;
  saveTimer: NodeJS.Timeout | null;
  evictTimer: NodeJS.Timeout | null;
  dirty: boolean;
}

const ROOM_EVICTION_GRACE_MS = 60_000;

export type BusPublish = (docId: string, type: "sync" | "awareness", payload: Uint8Array) => void;

export function roomName(docId: string): string {
  return `doc:${docId}`;
}

export function createRoomManager(io: Server, publish: BusPublish) {
  const rooms = new Map<string, Room>();
  // Deduplicates concurrent first-joins to the same not-yet-loaded
  // document: without this, two clients opening a brand-new document at
  // the same instant could each pass the `rooms.get(docId)` check before
  // either finishes loading, and end up building two independent Y.Doc
  // instances for the same docId (a "split-brain" room).
  const pendingCreations = new Map<string, Promise<Room>>();

  async function flush(room: Room): Promise<void> {
    if (!room.dirty) return;
    room.dirty = false;
    try {
      await saveDocumentState(room.docId, Y.encodeStateAsUpdate(room.doc));
    } catch (err) {
      console.error(`[room ${room.docId}] failed to persist state`, err);
      room.dirty = true; // retry on the next scheduled save
    }
  }

  function schedulePersist(room: Room) {
    room.dirty = true;
    if (room.saveTimer) clearTimeout(room.saveTimer);
    room.saveTimer = setTimeout(() => {
      room.saveTimer = null;
      void flush(room);
    }, config.persistDebounceMs);
  }

  function getOrCreateRoom(docId: string): Promise<Room> {
    const existing = rooms.get(docId);
    if (existing) return Promise.resolve(existing);

    const pending = pendingCreations.get(docId);
    if (pending) return pending;

    const building = buildRoom(docId).finally(() => pendingCreations.delete(docId));
    pendingCreations.set(docId, building);
    return building;
  }

  async function buildRoom(docId: string): Promise<Room> {
    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    // Server-side awareness never has "local" state of its own.
    awareness.setLocalState(null);

    const state = await loadDocumentState(docId);
    if (state) {
      Y.applyUpdate(doc, state, "db-load");
    } else {
      doc.getText("quill");
    }

    const room: Room = {
      docId,
      doc,
      awareness,
      refCount: 0,
      saveTimer: null,
      evictTimer: null,
      dirty: false,
    };

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      schedulePersist(room);
      if (origin === "redis-remote" || origin === "db-load") return;
      publish(docId, "sync", update);
      if (typeof origin === "string" && origin.startsWith("local:")) {
        const senderSocketId = origin.slice("local:".length);
        io.to(roomName(docId)).except(senderSocketId).emit("sync-update", { update: Buffer.from(update) });
      }
    });

    awareness.on("update", (changes: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      const changedClients = changes.added.concat(changes.updated, changes.removed);
      if (changedClients.length === 0) return;
      const update = awarenessProtocol.encodeAwarenessUpdate(awareness, changedClients);

      if (origin === "redis-remote") return; // originating instance already broadcast it

      publish(docId, "awareness", update);

      if (typeof origin === "string" && origin.startsWith("local:")) {
        const senderSocketId = origin.slice("local:".length);
        io.to(roomName(docId)).except(senderSocketId).emit("awareness-update", { update: Buffer.from(update) });
      } else {
        // Local removal (e.g. a client disconnected) - everyone still in the room needs it.
        io.to(roomName(docId)).emit("awareness-update", { update: Buffer.from(update) });
      }
    });

    rooms.set(docId, room);
    return room;
  }

  async function acquire(docId: string): Promise<Room> {
    const room = await getOrCreateRoom(docId);
    room.refCount += 1;
    if (room.evictTimer) {
      clearTimeout(room.evictTimer);
      room.evictTimer = null;
    }
    return room;
  }

  function release(docId: string) {
    const room = rooms.get(docId);
    if (!room) return;
    room.refCount = Math.max(0, room.refCount - 1);
    if (room.refCount > 0) return;

    room.evictTimer = setTimeout(() => {
      void (async () => {
        // A new client may have joined (and cleared/re-armed this timer)
        // between the timer firing and this callback actually running, or
        // while `flush` below is awaiting its DB write. Re-check refCount
        // at each point so we never destroy a room a client just acquired.
        if (room.refCount > 0) return;
        await flush(room);
        if (room.refCount > 0) return;
        if (room.saveTimer) clearTimeout(room.saveTimer);
        room.doc.destroy();
        room.awareness.destroy();
        rooms.delete(docId);
      })();
    }, ROOM_EVICTION_GRACE_MS);
  }

  function applyRemoteUpdate(docId: string, type: "sync" | "awareness", payload: Uint8Array) {
    const room = rooms.get(docId);
    if (!room) return; // not loaded on this instance; nothing local depends on it right now
    if (type === "sync") {
      Y.applyUpdate(room.doc, payload, "redis-remote");
    } else {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, payload, "redis-remote");
    }
  }

  function removeAwarenessClient(docId: string, clientId: number) {
    const room = rooms.get(docId);
    if (!room) return;
    awarenessProtocol.removeAwarenessStates(room.awareness, [clientId], "local:server");
  }

  async function flushAll(): Promise<void> {
    await Promise.all(Array.from(rooms.values()).map(flush));
  }

  return { acquire, release, applyRemoteUpdate, removeAwarenessClient, flushAll, rooms };
}

export type RoomManager = ReturnType<typeof createRoomManager>;
