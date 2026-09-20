import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import type { Server } from "socket.io";
import { config } from "../config.js";
import {
  loadDocumentState,
  saveDocumentState,
  insertSnapshot,
  getLatestSnapshotTime,
  insertUpdateLog,
  appendPendingUpdate,
  listPendingUpdates,
  clearPendingUpdates,
  getDocumentMeta,
} from "../documents/service.js";

export interface Room {
  docId: string;
  // Zero-knowledge documents never get their content decoded server-side
  // (see roomManager's module comment below), so most of the fields below
  // branch on this flag.
  encrypted: boolean;
  // Always a real Y.Doc — awareness needs one as its host regardless of
  // encryption (it just tracks doc.clientID / doc.on("destroy")). For an
  // encrypted room, this doc's *content* types (getText, getMap) are never
  // touched: all text/title/comments state lives only as opaque ciphertext
  // in latestCipherState/pendingCipherUpdates below, decodable only by
  // clients holding the key.
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  refCount: number;
  saveTimer: NodeJS.Timeout | null;
  evictTimer: NodeJS.Timeout | null;
  dirty: boolean;
  lastSnapshotAt: number;
  // ---- Encrypted-room relay state (unused, always empty, for plaintext rooms) ----
  // The most recent client-pushed encrypted checkpoint (full state), or
  // whatever was in document_state at load time.
  latestCipherState: Uint8Array | null;
  // Encrypted updates received since that checkpoint, oldest first. A
  // late-joining client decrypts the checkpoint, then decrypts and applies
  // each of these in order (or in any order — Yjs updates are
  // commutative — but "in order" mirrors how they were produced).
  pendingCipherUpdates: Uint8Array[];
}

const ROOM_EVICTION_GRACE_MS = 60_000;
// How far apart checkpoints in the version-history timeline are, at
// minimum. A snapshot is only taken (in addition to the one at document
// creation) when a debounced save fires AND this much time has passed
// since the last one — so a burst of typing produces one checkpoint, not
// hundreds.
const SNAPSHOT_INTERVAL_MS = 2 * 60_000;

export type BusMessageKind = "sync" | "awareness" | "checkpoint";
export type BusPublish = (docId: string, type: BusMessageKind, payload: Uint8Array) => void;

export function roomName(docId: string): string {
  return `doc:${docId}`;
}

// ---------------------------------------------------------------------------
// Zero-knowledge documents, in one paragraph:
//
// For an ordinary document this manager holds a live, decoded Y.Doc per
// room and merges every client's updates into it — that's what makes
// persistence, late-joiner bootstrap, and history/restore all work
// server-side. For an *encrypted* document the server never has the key,
// so it can never decode a single update, let alone merge several. It is
// reduced to a dumb, opaque relay + durable log: every encrypted update a
// client sends is appended to document_pending_updates and forwarded
// verbatim to the other clients in the room (who decrypt and merge it
// themselves, locally, with their own live Y.Doc). Periodically, whichever
// client is present re-encrypts its own fully-merged state and pushes it
// as a "checkpoint" — the server treats that as the new baseline and
// discards the pending log it superseded. See SocketIOProvider.ts on the
// frontend for the client half of this.
// ---------------------------------------------------------------------------

export function createRoomManager(io: Server, publish: BusPublish) {
  const rooms = new Map<string, Room>();
  // Deduplicates concurrent first-joins to the same not-yet-loaded
  // document: without this, two clients joining the same brand-new document
  // at the same instant could both pass the `rooms.get(docId)` check before
  // either finishes loading, and end up building two independent Room
  // instances for the same docId ("split-brain" room).
  const pendingCreations = new Map<string, Promise<Room>>();

  async function flush(room: Room): Promise<void> {
    // Encrypted rooms are never marked dirty (there is nothing the server
    // itself can compact — see module comment), so this is naturally a
    // no-op for them.
    if (!room.dirty) return;
    room.dirty = false;
    const state = Y.encodeStateAsUpdate(room.doc);
    try {
      await saveDocumentState(room.docId, state);
    } catch (err) {
      console.error(`[room ${room.docId}] failed to persist state`, err);
      room.dirty = true; // retry on the next scheduled save
      return;
    }

    if (Date.now() - room.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      room.lastSnapshotAt = Date.now();
      try {
        await insertSnapshot(room.docId, state);
      } catch (err) {
        console.error(`[room ${room.docId}] failed to write snapshot`, err);
      }
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
    const meta = await getDocumentMeta(docId);
    const encrypted = meta?.encrypted ?? false;

    const doc = new Y.Doc();
    const awareness = new awarenessProtocol.Awareness(doc);
    // Server-side awareness never has "local" state of its own.
    awareness.setLocalState(null);

    const lastSnapshotAt = (await getLatestSnapshotTime(docId)) ?? 0;

    const room: Room = {
      docId,
      encrypted,
      doc,
      awareness,
      refCount: 0,
      saveTimer: null,
      evictTimer: null,
      dirty: false,
      lastSnapshotAt,
      latestCipherState: null,
      pendingCipherUpdates: [],
    };

    if (encrypted) {
      // Opaque bytes in, opaque bytes held in memory — never decoded here.
      room.latestCipherState = await loadDocumentState(docId);
      room.pendingCipherUpdates = await listPendingUpdates(docId);
    } else {
      const state = await loadDocumentState(docId);
      if (state) {
        Y.applyUpdate(doc, state, "db-load");
      } else {
        doc.getText("quill");
      }

      doc.on("update", (update: Uint8Array, origin: unknown) => {
        schedulePersist(room);
        if (origin === "redis-remote" || origin === "db-load") return;
        // Every state-changing operation on a plaintext room's live doc
        // funnels through here — ordinary edits, history restores, and
        // branch merges alike — so logging it here (once, on whichever
        // instance originated it) gives the timelapse player a complete,
        // exactly-once operation log for free.
        insertUpdateLog(docId, update).catch((err) =>
          console.error(`[room ${docId}] failed to log update for timelapse`, err)
        );
        publish(docId, "sync", update);
        if (typeof origin === "string" && origin.startsWith("local:")) {
          const senderSocketId = origin.slice("local:".length);
          io.to(roomName(docId)).except(senderSocketId).emit("sync-update", { update: Buffer.from(update) });
        }
      });
    }

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

  /** A client's normal (non-checkpoint) sync-update, routed here so plaintext vs. encrypted handling stays in one place. */
  function applyClientUpdate(docId: string, senderSocketId: string, update: Uint8Array): void {
    const room = rooms.get(docId);
    if (!room) return;

    if (room.encrypted) {
      room.pendingCipherUpdates.push(update);
      insertUpdateLog(docId, update).catch((err) =>
        console.error(`[room ${docId}] failed to log encrypted update for timelapse`, err)
      );
      appendPendingUpdate(docId, update).catch((err) =>
        console.error(`[room ${docId}] failed to persist pending encrypted update`, err)
      );
      publish(docId, "sync", update);
      io.to(roomName(docId)).except(senderSocketId).emit("sync-update", { update: Buffer.from(update) });
    } else {
      // Triggers the doc.on("update") handler registered in buildRoom,
      // which takes care of persistence, the timelapse log, and broadcast.
      Y.applyUpdate(room.doc, update, `local:${senderSocketId}`);
    }
  }

  /**
   * A client's explicit compaction checkpoint for an encrypted room: its
   * own locally-merged full state, re-encrypted. Only meaningful for
   * encrypted rooms — see the module comment.
   */
  async function applyCheckpoint(docId: string, senderSocketId: string, state: Uint8Array): Promise<void> {
    const room = rooms.get(docId);
    if (!room || !room.encrypted) return;

    room.latestCipherState = state;
    room.pendingCipherUpdates = [];

    try {
      await saveDocumentState(docId, state);
      await clearPendingUpdates(docId);
      if (Date.now() - room.lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
        room.lastSnapshotAt = Date.now();
        await insertSnapshot(docId, state);
      }
    } catch (err) {
      console.error(`[room ${docId}] failed to persist checkpoint`, err);
    }

    // No socket broadcast needed: every connected client already has the
    // fully-merged content locally (they applied each update as it
    // streamed in). This is purely a storage-compaction signal for other
    // backend instances that might have this room loaded too.
    publish(docId, "checkpoint", state);
  }

  function applyRemoteUpdate(docId: string, type: BusMessageKind, payload: Uint8Array) {
    const room = rooms.get(docId);
    if (!room) return; // not loaded on this instance; nothing local depends on it right now
    if (type === "sync") {
      if (room.encrypted) {
        // Already durably persisted by the originating instance; just keep
        // this instance's own in-memory bootstrap state current too.
        room.pendingCipherUpdates.push(payload);
      } else {
        Y.applyUpdate(room.doc, payload, "redis-remote");
      }
    } else if (type === "awareness") {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, payload, "redis-remote");
    } else if (type === "checkpoint") {
      room.latestCipherState = payload;
      room.pendingCipherUpdates = [];
    }
  }

  function removeAwarenessClient(docId: string, clientId: number) {
    const room = rooms.get(docId);
    if (!room) return;
    awarenessProtocol.removeAwarenessStates(room.awareness, [clientId], "local:server");
  }

  // Replaces the live document's content with an older snapshot's content,
  // expressed as a normal CRDT transaction (delete-all + re-insert the old
  // delta) rather than swapping the Y.Doc wholesale. This is the
  // Yjs-recommended way to "revert": it produces a regular update that
  // merges correctly with whatever every other connected client has done
  // since, and flows through the exact same broadcast/persist/redis-publish
  // path as any other edit (origin "local:restore" behaves like a
  // sender-less local change: nothing to except from the room broadcast).
  //
  // Only meaningful for plaintext rooms: an encrypted room's server-side
  // doc is never decoded, so restore-to-an-older-version for those happens
  // entirely client-side (decrypt the snapshot, diff against the live
  // local doc, transact — see HistoryDrawer.tsx), producing an ordinary
  // encrypted update that flows through the normal relay path instead.
  async function restoreFromSnapshot(docId: string, snapshotState: Uint8Array): Promise<void> {
    const room = await getOrCreateRoom(docId);
    if (room.encrypted) {
      throw new Error("restoreFromSnapshot is not supported for encrypted documents; restore happens client-side");
    }
    const tempDoc = new Y.Doc();
    try {
      Y.applyUpdate(tempDoc, snapshotState, "restore-temp");
      const oldDelta = tempDoc.getText("quill").toDelta();
      room.doc.transact(() => {
        const liveText = room.doc.getText("quill");
        liveText.delete(0, liveText.length);
        liveText.applyDelta(oldDelta);
      }, "local:restore");
    } finally {
      tempDoc.destroy();
    }
  }

  // Applies an externally-computed full Yjs state directly onto a live
  // room's doc via Y.applyUpdate — the textbook way to merge two diverged
  // CRDT replicas (Yjs's whole point is that this is commutative,
  // idempotent, and structurally merges automatically). This is what
  // powers "merge branch into main": the browser decrypts/decodes both
  // sides, computes the merged state itself (see BranchMergeModal.tsx),
  // and this just needs to fold it into the target room so every
  // connected client picks it up immediately. Only for plaintext targets —
  // an encrypted target instead receives the merged state as a normal
  // client-pushed checkpoint over the socket, no REST call needed.
  async function mergeExternalState(docId: string, externalState: Uint8Array): Promise<void> {
    const room = await getOrCreateRoom(docId);
    if (room.encrypted) {
      throw new Error("mergeExternalState is not supported for encrypted documents; push a checkpoint instead");
    }
    Y.applyUpdate(room.doc, externalState, "local:merge");
  }

  /**
   * The best current state the server can hand out for a document —
   * whether that's a live in-memory room or nothing loaded right now — as
   * a (baseline, pending-updates-since-baseline) pair. For a plaintext
   * document `pending` is always empty because the server already keeps
   * one continuously-merged doc; for an encrypted document the caller (a
   * browser, which holds the key) is the one that merges baseline+pending
   * together. Used by branch-forking (a pure byte copy either way) and by
   * the merge-preview endpoint.
   */
  async function getCurrentStateParts(docId: string): Promise<{ baseline: Uint8Array | null; pending: Uint8Array[] }> {
    const room = rooms.get(docId);
    if (room) {
      if (room.encrypted) {
        return { baseline: room.latestCipherState, pending: [...room.pendingCipherUpdates] };
      }
      return { baseline: Y.encodeStateAsUpdate(room.doc), pending: [] };
    }
    const meta = await getDocumentMeta(docId);
    const baseline = await loadDocumentState(docId);
    if (meta?.encrypted) {
      return { baseline, pending: await listPendingUpdates(docId) };
    }
    return { baseline, pending: [] };
  }

  async function flushAll(): Promise<void> {
    await Promise.all(Array.from(rooms.values()).map(flush));
  }

  return {
    acquire,
    release,
    applyClientUpdate,
    applyCheckpoint,
    applyRemoteUpdate,
    removeAwarenessClient,
    restoreFromSnapshot,
    mergeExternalState,
    getCurrentStateParts,
    flushAll,
    rooms,
  };
}

export type RoomManager = ReturnType<typeof createRoomManager>;
