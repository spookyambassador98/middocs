// A minimal, from-scratch Yjs provider built on Socket.io.
//
// y-websocket (the "official" Yjs network provider) assumes a raw
// WebSocket. This app uses Socket.io instead (for its automatic
// reconnection, room support, and — most importantly — the Redis adapter
// that makes it horizontally scalable), so we speak the same underlying
// Yjs sync/awareness protocols but tunnel them over Socket.io events
// instead of a raw ws:// connection.
//
// Binary Yjs updates are sent as-is inside Socket.io event payloads
// (Socket.io transparently supports ArrayBuffer/Uint8Array/Buffer within
// an emitted object), so no extra base64/JSON encoding is needed.
//
// Zero-knowledge mode (when `encryptionKey` is supplied): every outgoing
// Yjs update — and the periodic full-state "checkpoint" this provider
// pushes to let the server compact its storage — is AES-GCM encrypted
// here before it ever reaches `socket.emit`, and every incoming one is
// decrypted here before `Y.applyUpdate` ever sees it. The server (see
// roomManager.ts) never has the key and only ever handles these as opaque
// bytes. See crypto.ts for the encryption primitives and exactly what
// this covers.
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { IndexeddbPersistence } from "y-indexeddb";
import { API_URL } from "../api/client";
import { decryptBytes, encryptBytes } from "./crypto";
import { WebRtcMesh, isWebRtcMeshSupported, type WireSignal } from "./webrtcMesh";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface JoinAck {
  ok: boolean;
  error?: string;
  encrypted?: boolean;
  title?: string;
  ownerId?: string;
  state?: ArrayBuffer | null;
  pendingUpdates?: ArrayBuffer[];
  awareness?: ArrayBuffer;
}

export interface ReactionEvent {
  emoji: string;
  clientId: number;
}

export interface AttributionEvent {
  index: number;
  length: number;
  clientId: number;
}

type Listener<T> = (value: T) => void;

// A local edit burst gets compacted into a fresh encrypted checkpoint
// after this many individual updates, or this much idle time, whichever
// comes first — mirroring the plaintext room's own SNAPSHOT_INTERVAL_MS
// idea, just triggered client-side since only the client can decode
// enough to produce a compacted state for an encrypted document.
const CHECKPOINT_OP_THRESHOLD = 25;
const CHECKPOINT_INTERVAL_MS = 45_000;

export class SocketIOProvider {
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  public readonly encrypted: boolean;
  public status: ConnectionStatus = "connecting";

  private socket: Socket;
  private docId: string;
  private localUser: { name: string; color: string };
  private encryptionKey: CryptoKey | undefined;
  private persistence: IndexeddbPersistence;
  private statusListeners = new Set<Listener<ConnectionStatus>>();
  private readyListeners = new Set<Listener<{ title: string; ownerId: string }>>();
  private errorListeners = new Set<Listener<string>>();
  private reactionListeners = new Set<Listener<ReactionEvent>>();
  private attributionListeners = new Set<Listener<AttributionEvent>>();
  private meshPeerCountListeners = new Set<Listener<number>>();
  private hasSynced = false;
  private opsSinceCheckpoint = 0;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  // Supplementary peer-to-peer resilience — see webrtcMesh.ts. Null when
  // the browser doesn't support WebRTC at all; every use below is
  // optional-chained, so the provider degrades to server-only sync (its
  // original behavior) with no special-casing needed elsewhere.
  private mesh: WebRtcMesh | null = null;

  constructor(
    docId: string,
    token: string,
    localUser: { name: string; color: string },
    encryptionKey?: CryptoKey
  ) {
    this.docId = docId;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.localUser = localUser;
    this.encryptionKey = encryptionKey;
    this.encrypted = Boolean(encryptionKey);

    // Offline-first durability: every local edit is mirrored into the
    // browser's IndexedDB as it happens (already-decrypted plaintext, on
    // the user's own device — no different from any local-first app
    // caching its own user's data). If the connection drops, editing keeps
    // working against the in-memory Y.Doc as normal — this is what makes a
    // page reload or browser restart *while offline* not lose anything.
    // Namespaced per document so switching documents doesn't mix state.
    this.persistence = new IndexeddbPersistence(`mgd-doc-${docId}`, this.doc);

    this.socket = io(API_URL, {
      auth: { token },
      transports: ["websocket", "polling"],
      // socket.io-client multiplexes/caches connections by URI by default,
      // which would hand a brand-new provider (e.g. after navigating from
      // one document to another) the *same* underlying socket — and with
      // it, every listener the previous provider registered. forceNew
      // guarantees each provider owns an independent connection.
      forceNew: true,
    });

    this.doc.on("update", this.handleLocalDocUpdate);
    this.awareness.on("update", this.handleLocalAwarenessUpdate);

    this.socket.on("connect", this.join);
    this.socket.on("disconnect", () => this.setStatus("disconnected"));
    this.socket.on("connect_error", (err) => {
      this.setStatus("disconnected");
      this.errorListeners.forEach((l) => l(err.message));
    });
    this.socket.on("sync-update", ({ update }: { update: ArrayBuffer }) => {
      void this.applyIncomingWireBytes(new Uint8Array(update), "remote");
    });
    this.socket.on("awareness-update", ({ update }: { update: ArrayBuffer }) => {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(update), "remote");
    });
    this.socket.on("reaction", (event: ReactionEvent) => {
      this.reactionListeners.forEach((l) => l(event));
    });
    this.socket.on("attribution", (event: AttributionEvent) => {
      this.attributionListeners.forEach((l) => l(event));
    });

    // ---------- P2P mesh (supplementary to, never a replacement for, the server) ----------
    if (isWebRtcMeshSupported()) {
      this.mesh = new WebRtcMesh(
        this.awareness.clientID,
        (toClientId, signal) => this.socket.emit("webrtc-signal", { docId: this.docId, toClientId, signal }),
        (bytes) => void this.applyIncomingWireBytes(bytes, "webrtc-peer"),
        (remoteClientId) => this.sendMeshHandshake(remoteClientId)
      );
      const mesh = this.mesh;
      mesh.onPeerCountChange((count) => this.meshPeerCountListeners.forEach((l) => l(count)));

      this.socket.on("webrtc-signal", ({ fromClientId, signal }: { fromClientId: number; signal: WireSignal }) => {
        void mesh.receiveSignal(fromClientId, signal);
      });

      // Every awareness change (ours or a peer's) is a cheap, always-fresh
      // snapshot of "who else is actually in this document room right
      // now" — reconciling the mesh against it on every change is more
      // than we strictly need (awareness also updates on every cursor
      // move), but reconcile() is a no-op for peers we're already
      // connected to, so the extra calls cost only a couple of Set
      // lookups.
      this.awareness.on("update", this.handleMeshAwarenessChange);
    }
  }

  private handleMeshAwarenessChange = () => {
    if (!this.mesh) return;
    const peerIds = Array.from(this.awareness.getStates().keys());
    this.mesh.reconcile(peerIds);
  };

  /** The number of currently-open direct peer connections — surfaced in the editor topbar as a small "P2P" indicator. Always 0 if the browser doesn't support WebRTC. */
  get meshPeerCount(): number {
    return this.mesh?.openPeerCount() ?? 0;
  }

  onMeshPeerCountChange(listener: Listener<number>) {
    this.meshPeerCountListeners.add(listener);
    return () => this.meshPeerCountListeners.delete(listener);
  }

  /** Sent once, right when a direct connection to a peer opens: our full current state, so that peer is caught up even in the (normal) case where they connected to us before either side had synced everything through the server. Harmless to "over-send" — Yjs states are idempotent to re-apply. */
  private sendMeshHandshake(remoteClientId: number): void {
    if (!this.mesh) return;
    const mesh = this.mesh;
    void (async () => {
      try {
        const state = Y.encodeStateAsUpdate(this.doc);
        const wireBytes = this.encryptionKey ? await encryptBytes(this.encryptionKey, state) : state;
        mesh.sendTo(remoteClientId, wireBytes);
      } catch (err) {
        console.error("[SocketIOProvider] failed to send P2P handshake state", err);
      }
    })();
  }

  /** Broadcasts an ephemeral emoji reaction to everyone else in the document (not persisted, not part of the CRDT). */
  sendReaction(emoji: string) {
    this.socket.emit("reaction", { docId: this.docId, emoji });
  }

  onReaction(listener: Listener<ReactionEvent>) {
    this.reactionListeners.add(listener);
    return () => this.reactionListeners.delete(listener);
  }

  /** Broadcasts "I just typed at this range" for the live attribution heatmap — ephemeral, not part of the CRDT. */
  sendAttribution(index: number, length: number) {
    this.socket.emit("attribution", { docId: this.docId, index, length });
  }

  onAttribution(listener: Listener<AttributionEvent>) {
    this.attributionListeners.add(listener);
    return () => this.attributionListeners.delete(listener);
  }

  private join = () => {
    this.setStatus("connecting");
    this.socket.emit(
      "join-document",
      { docId: this.docId, awarenessClientId: this.awareness.clientID },
      (ack: JoinAck) => {
        void this.handleJoinAck(ack);
      }
    );
  };

  private async handleJoinAck(ack: JoinAck): Promise<void> {
    if (!ack.ok) {
      this.errorListeners.forEach((l) => l(ack.error ?? "Could not connect to the document"));
      this.setStatus("disconnected");
      return;
    }

    try {
      if (ack.encrypted) {
        if (!this.encryptionKey) {
          this.errorListeners.forEach((l) => l("This document needs its access key. Open the full link."));
          this.setStatus("disconnected");
          return;
        }
        if (ack.state) {
          const plain = await decryptBytes(this.encryptionKey, new Uint8Array(ack.state));
          Y.applyUpdate(this.doc, plain, "server-init");
        }
        for (const pending of ack.pendingUpdates ?? []) {
          const plain = await decryptBytes(this.encryptionKey, new Uint8Array(pending));
          Y.applyUpdate(this.doc, plain, "server-init");
        }
        if (!this.checkpointTimer) {
          this.checkpointTimer = setInterval(() => void this.pushCheckpoint(), CHECKPOINT_INTERVAL_MS);
        }
      } else if (ack.state) {
        Y.applyUpdate(this.doc, new Uint8Array(ack.state), "server-init");
      }
    } catch (err) {
      console.error("[SocketIOProvider] failed to decrypt document state", err);
      this.errorListeners.forEach((l) => l("Could not decrypt the document. The access key is wrong."));
      this.setStatus("disconnected");
      return;
    }

    if (ack.awareness) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(ack.awareness), "server-init");
    }

    // Announce who we are. Doing this only *after* joining guarantees the
    // server has already put our socket in the document's room.
    this.awareness.setLocalStateField("user", this.localUser);

    this.setStatus("connected");
    if (!this.hasSynced) {
      this.hasSynced = true;
      this.readyListeners.forEach((l) => l({ title: ack.title!, ownerId: ack.ownerId! }));
    }
  }

  /** Applies bytes that arrived over the wire — either the server's "sync-update" or a direct WebRTC data-channel message, tagged with `origin` so handleLocalDocUpdate below knows not to loop them straight back out. */
  private async applyIncomingWireBytes(bytes: Uint8Array, origin: string): Promise<void> {
    if (this.encryptionKey) {
      try {
        const plain = await decryptBytes(this.encryptionKey, bytes);
        Y.applyUpdate(this.doc, plain, origin);
      } catch (err) {
        console.error("[SocketIOProvider] failed to decrypt incoming update", err);
      }
      return;
    }
    Y.applyUpdate(this.doc, bytes, origin);
  }

  private handleLocalDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || origin === "server-init" || origin === "webrtc-peer") return;
    if (this.encryptionKey) {
      void this.sendEncryptedUpdate(update);
      return;
    }
    this.socket.emit("sync-update", { docId: this.docId, update });
    this.mesh?.send(update);
  };

  private async sendEncryptedUpdate(update: Uint8Array): Promise<void> {
    if (!this.encryptionKey) return;
    try {
      const cipher = await encryptBytes(this.encryptionKey, update);
      this.socket.emit("sync-update", { docId: this.docId, update: cipher });
      this.mesh?.send(cipher);
      this.opsSinceCheckpoint += 1;
      if (this.opsSinceCheckpoint >= CHECKPOINT_OP_THRESHOLD) {
        void this.pushCheckpoint();
      }
    } catch (err) {
      console.error("[SocketIOProvider] failed to encrypt outgoing update", err);
    }
  }

  private async pushCheckpoint(): Promise<void> {
    if (!this.encryptionKey) return;
    this.opsSinceCheckpoint = 0;
    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      const cipher = await encryptBytes(this.encryptionKey, state);
      this.socket.emit("checkpoint", { docId: this.docId, state: cipher });
    } catch (err) {
      console.error("[SocketIOProvider] failed to push encrypted checkpoint", err);
    }
  }

  private handleLocalAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === "remote" || origin === "server-init") return;
    const changedClients = added.concat(updated, removed);
    if (changedClients.length === 0) return;
    const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients);
    this.socket.emit("awareness-update", { docId: this.docId, update });
  };

  private setStatus(status: ConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  onStatusChange(listener: Listener<ConnectionStatus>) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onReady(listener: Listener<{ title: string; ownerId: string }>) {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  onError(listener: Listener<string>) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  destroy() {
    // Best-effort final compaction: fired before we tear the socket down
    // so it has the best chance of actually reaching the server in the
    // same tick. Not awaited — a page navigating away can't wait around,
    // and the periodic timer already covers most cases while the tab was
    // open.
    if (this.encryptionKey) void this.pushCheckpoint();
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);

    this.doc.off("update", this.handleLocalDocUpdate);
    this.awareness.off("update", this.handleLocalAwarenessUpdate);
    this.awareness.off("update", this.handleMeshAwarenessChange);
    this.mesh?.destroy();
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "window-unload");
    this.socket.emit("leave-document");
    this.socket.off();
    this.socket.disconnect();
    void this.persistence.destroy();
    this.doc.destroy();
    this.statusListeners.clear();
    this.readyListeners.clear();
    this.errorListeners.clear();
    this.reactionListeners.clear();
    this.attributionListeners.clear();
    this.meshPeerCountListeners.clear();
  }
}
