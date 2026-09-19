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
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { API_URL } from "../api/client";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

interface JoinAck {
  ok: boolean;
  error?: string;
  title?: string;
  ownerId?: string;
  state?: ArrayBuffer;
  awareness?: ArrayBuffer;
}

type Listener<T> = (value: T) => void;

export class SocketIOProvider {
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  public status: ConnectionStatus = "connecting";

  private socket: Socket;
  private docId: string;
  private localUser: { name: string; color: string };
  private statusListeners = new Set<Listener<ConnectionStatus>>();
  private readyListeners = new Set<Listener<{ title: string; ownerId: string }>>();
  private errorListeners = new Set<Listener<string>>();
  private hasSynced = false;

  constructor(docId: string, token: string, localUser: { name: string; color: string }) {
    this.docId = docId;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    this.localUser = localUser;

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
      Y.applyUpdate(this.doc, new Uint8Array(update), "remote");
    });
    this.socket.on("awareness-update", ({ update }: { update: ArrayBuffer }) => {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(update), "remote");
    });
  }

  private join = () => {
    this.setStatus("connecting");
    this.socket.emit(
      "join-document",
      { docId: this.docId, awarenessClientId: this.awareness.clientID },
      (ack: JoinAck) => {
        if (!ack.ok || !ack.state || !ack.awareness) {
          this.errorListeners.forEach((l) => l(ack.error ?? "Не удалось подключиться к документу"));
          this.setStatus("disconnected");
          return;
        }

        Y.applyUpdate(this.doc, new Uint8Array(ack.state), "server-init");
        awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(ack.awareness), "server-init");

        // Announce who we are. Doing this only *after* joining guarantees
        // the server has already put our socket in the document's room.
        this.awareness.setLocalStateField("user", this.localUser);

        this.setStatus("connected");
        if (!this.hasSynced) {
          this.hasSynced = true;
          this.readyListeners.forEach((l) => l({ title: ack.title!, ownerId: ack.ownerId! }));
        }
      }
    );
  };

  private handleLocalDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || origin === "server-init") return;
    this.socket.emit("sync-update", { docId: this.docId, update });
  };

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
    this.doc.off("update", this.handleLocalDocUpdate);
    this.awareness.off("update", this.handleLocalAwarenessUpdate);
    awarenessProtocol.removeAwarenessStates(this.awareness, [this.doc.clientID], "window-unload");
    this.socket.emit("leave-document");
    this.socket.off();
    this.socket.disconnect();
    this.doc.destroy();
    this.statusListeners.clear();
    this.readyListeners.clear();
    this.errorListeners.clear();
  }
}
