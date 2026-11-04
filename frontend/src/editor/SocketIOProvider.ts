// Realtime used to ride Socket.io on a long-running host. That host no
// longer answers, and a websocket client retries forever — the editor
// looked stuck. This provider keeps the same surface (Y.Doc, awareness,
// reactions) and syncs through the same-origin HTTP API instead.
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { IndexeddbPersistence } from "y-indexeddb";
import { API_URL } from "../api/client";
import { base64ToBytes, bytesToBase64, decryptBytes, encryptBytes } from "./crypto";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

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

interface SyncPayload {
  title: string;
  ownerId: string;
  encrypted: boolean;
  state: string;
  pending: string[];
  awareness: { clientId: string; update: string }[];
  signals: { id: number; kind: string; emoji?: string; clientId?: string | number; index?: number; length?: number }[];
}

const CHECKPOINT_OP_THRESHOLD = 25;
const CHECKPOINT_INTERVAL_MS = 45_000;
const POLL_MS = 3000;

function authHeaders(token: string): HeadersInit {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

export class SocketIOProvider {
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  public readonly encrypted: boolean;
  public status: ConnectionStatus = "connecting";

  private docId: string;
  private token: string;
  private localUser: { name: string; color: string };
  private encryptionKey: CryptoKey | undefined;
  private persistence: IndexeddbPersistence;
  private statusListeners = new Set<Listener<ConnectionStatus>>();
  private readyListeners = new Set<Listener<{ title: string; ownerId: string }>>();
  private errorListeners = new Set<Listener<string>>();
  private reactionListeners = new Set<Listener<ReactionEvent>>();
  private attributionListeners = new Set<Listener<AttributionEvent>>();
  private hasSynced = false;
  private opsSinceCheckpoint = 0;
  private checkpointTimer: ReturnType<typeof setInterval> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private signalCursor = 0;
  private destroyed = false;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private awarenessTimer: ReturnType<typeof setTimeout> | null = null;
  private lastState = "";

  constructor(
    docId: string,
    token: string,
    localUser: { name: string; color: string },
    encryptionKey?: CryptoKey
  ) {
    this.docId = docId;
    this.token = token;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.localUser = localUser;
    this.encryptionKey = encryptionKey;
    this.encrypted = Boolean(encryptionKey);
    this.persistence = new IndexeddbPersistence(`mgd-doc-${docId}`, this.doc);

    this.doc.on("update", this.handleLocalDocUpdate);
    this.awareness.on("update", this.handleLocalAwarenessUpdate);
    void this.bootstrap();
  }

  sendReaction(emoji: string) {
    void this.post({ type: "signal", kind: "reaction", emoji, clientId: this.doc.clientID });
  }

  onReaction(listener: Listener<ReactionEvent>) {
    this.reactionListeners.add(listener);
    return () => this.reactionListeners.delete(listener);
  }

  sendAttribution(index: number, length: number) {
    void this.post({ type: "signal", kind: "attribution", index, length, clientId: this.doc.clientID });
  }

  onAttribution(listener: Listener<AttributionEvent>) {
    this.attributionListeners.add(listener);
    return () => this.attributionListeners.delete(listener);
  }

  private async bootstrap() {
    try {
      const payload = await this.pull();
      await this.applySnapshot(payload, true);
      this.awareness.setLocalStateField("user", this.localUser);
      this.setStatus("connected");
      if (!this.hasSynced) {
        this.hasSynced = true;
        this.readyListeners.forEach((l) => l({ title: payload.title, ownerId: payload.ownerId }));
      }
      if (this.encryptionKey && !this.checkpointTimer) {
        this.checkpointTimer = setInterval(() => void this.pushCheckpoint(), CHECKPOINT_INTERVAL_MS);
      }
      this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
    } catch (err) {
      console.error("[sync] join failed", err);
      this.errorListeners.forEach((l) => l("Could not open the document"));
      this.setStatus("disconnected");
      if (!this.destroyed) {
        this.pollTimer = setInterval(() => void this.poll(), POLL_MS);
      }
    }
  }

  private async poll() {
    if (this.destroyed) return;
    try {
      const payload = await this.pull();
      await this.applySnapshot(payload, false);
      if (this.status !== "connected") this.setStatus("connected");
      if (!this.hasSynced) {
        this.hasSynced = true;
        this.readyListeners.forEach((l) => l({ title: payload.title, ownerId: payload.ownerId }));
      }
    } catch {
      this.setStatus("disconnected");
    }
  }

  private async pull(): Promise<SyncPayload> {
    const response = await fetch(`${API_URL}/api/sync/${this.docId}?since=${this.signalCursor}`, {
      headers: authHeaders(this.token),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`sync ${response.status}`);
    return response.json() as Promise<SyncPayload>;
  }

  private async post(body: Record<string, unknown>) {
    const response = await fetch(`${API_URL}/api/sync/${this.docId}`, {
      method: "POST",
      headers: authHeaders(this.token),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`sync post ${response.status}`);
  }

  private async applySnapshot(payload: SyncPayload, initial: boolean) {
    const origin = initial ? "server-init" : "remote";
    if (payload.state && (initial || (!this.dirty && payload.state !== this.lastState))) {
      this.lastState = payload.state;
      const bytes = base64ToBytes(payload.state);
      if (this.encryptionKey) {
        try {
          Y.applyUpdate(this.doc, await decryptBytes(this.encryptionKey, bytes), origin);
        } catch (err) {
          if (initial) throw err;
        }
      } else {
        Y.applyUpdate(this.doc, bytes, origin);
      }
    }
    for (const pending of payload.pending || []) {
      const bytes = base64ToBytes(pending);
      if (this.encryptionKey) {
        Y.applyUpdate(this.doc, await decryptBytes(this.encryptionKey, bytes), origin);
      }
    }
    for (const item of payload.awareness || []) {
      if (String(item.clientId) === String(this.doc.clientID)) continue;
      awarenessProtocol.applyAwarenessUpdate(this.awareness, base64ToBytes(item.update), "remote");
    }
    for (const signal of payload.signals || []) {
      this.signalCursor = Math.max(this.signalCursor, signal.id);
      if (Number(signal.clientId) === this.doc.clientID) continue;
      if (signal.kind === "reaction" && signal.emoji) {
        this.reactionListeners.forEach((l) => l({ emoji: signal.emoji!, clientId: Number(signal.clientId) }));
      }
      if (signal.kind === "attribution" && typeof signal.index === "number") {
        this.attributionListeners.forEach((l) =>
          l({ index: signal.index!, length: signal.length || 0, clientId: Number(signal.clientId) })
        );
      }
    }
  }

  private handleLocalDocUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || origin === "server-init") return;
    this.dirty = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => void this.flushLocal(), 1200);
  };

  private async flushLocal() {
    this.flushTimer = null;
    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      if (this.encryptionKey) {
        const cipher = await encryptBytes(this.encryptionKey, state);
        const encoded = bytesToBase64(cipher);
        await this.post({ type: "checkpoint", state: encoded });
        this.lastState = encoded;
      } else {
        const encoded = bytesToBase64(state);
        await this.post({ type: "update", update: encoded });
        this.lastState = encoded;
      }
      this.dirty = false;
      this.opsSinceCheckpoint = 0;
    } catch (err) {
      console.error("[sync] flush failed", err);
      if (!this.destroyed) this.flushTimer = setTimeout(() => void this.flushLocal(), 800);
    }
  }

  private async pushCheckpoint(): Promise<void> {
    if (!this.encryptionKey) return;
    this.opsSinceCheckpoint = 0;
    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      const cipher = await encryptBytes(this.encryptionKey, state);
      await this.post({ type: "checkpoint", state: bytesToBase64(cipher) });
    } catch (err) {
      console.error("[sync] checkpoint failed", err);
    }
  }

  private handleLocalAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown
  ) => {
    if (origin === "remote" || origin === "server-init") return;
    const changedClients = added.concat(updated, removed);
    if (changedClients.length === 0) return;
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    this.awarenessTimer = setTimeout(() => {
      this.awarenessTimer = null;
      const update = awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.doc.clientID]);
      void this.post({
        type: "awareness",
        clientId: String(this.doc.clientID),
        update: bytesToBase64(update),
      }).catch(() => undefined);
    }, 1500);
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
    this.destroyed = true;
    if (this.encryptionKey) void this.pushCheckpoint();
    if (this.checkpointTimer) clearInterval(this.checkpointTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    if (this.awarenessTimer) clearTimeout(this.awarenessTimer);
    this.doc.off("update", this.handleLocalDocUpdate);
    this.awareness.off("update", this.handleLocalAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "window-unload");
    void this.persistence.destroy();
    this.doc.destroy();
    this.statusListeners.clear();
    this.readyListeners.clear();
    this.errorListeners.clear();
    this.reactionListeners.clear();
    this.attributionListeners.clear();
  }
}
