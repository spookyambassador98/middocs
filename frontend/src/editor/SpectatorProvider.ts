// A read-only, no-login sibling of SocketIOProvider for the public "watch
// live" link (see schema.sql's spectator_token, backend socket.ts's
// "join-spectate", and routes.ts's spectator-link endpoints). Deliberately
// its own, much smaller class rather than a runtime flag on the full
// read-write provider: a spectator never authenticates, never carries a
// decryption key (encrypted documents can't be spectated at all — the
// server refuses to mint a token for one), never has an awareness
// identity of its own, and structurally has no method that could send
// anything — that's a stronger guarantee than an "if (isSpectator) return"
// scattered through SocketIOProvider would be.
import { io, type Socket } from "socket.io-client";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness.js";
import { API_URL } from "../api/client";

export type SpectatorStatus = "connecting" | "connected" | "disconnected";

interface SpectateJoinAck {
  ok: boolean;
  error?: string;
  title?: string;
  icon?: string;
  state?: ArrayBuffer | null;
  awareness?: ArrayBuffer;
}

type Listener<T> = (value: T) => void;

export class SpectatorProvider {
  public readonly doc: Y.Doc;
  public readonly awareness: awarenessProtocol.Awareness;
  public status: SpectatorStatus = "connecting";

  private socket: Socket;
  private token: string;
  private statusListeners = new Set<Listener<SpectatorStatus>>();
  private readyListeners = new Set<Listener<{ title: string; icon: string }>>();
  private errorListeners = new Set<Listener<string>>();
  private hasSynced = false;

  constructor(token: string) {
    this.token = token;
    this.doc = new Y.Doc();
    this.awareness = new awarenessProtocol.Awareness(this.doc);
    // We never call setLocalState/setLocalStateField — a spectator
    // contributes no presence of its own, only receives everyone else's.

    this.socket = io(API_URL, {
      auth: { spectatorToken: token },
      transports: ["websocket", "polling"],
      forceNew: true,
    });

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
    this.socket.emit("join-spectate", { token: this.token }, (ack: SpectateJoinAck) => {
      if (!ack.ok) {
        this.errorListeners.forEach((l) => l(ack.error ?? "Could not join the broadcast"));
        this.setStatus("disconnected");
        return;
      }
      if (ack.state) {
        Y.applyUpdate(this.doc, new Uint8Array(ack.state), "server-init");
      }
      if (ack.awareness) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, new Uint8Array(ack.awareness), "server-init");
      }
      this.setStatus("connected");
      if (!this.hasSynced) {
        this.hasSynced = true;
        this.readyListeners.forEach((l) => l({ title: ack.title ?? "", icon: ack.icon ?? "📄" }));
      }
    });
  };

  private setStatus(status: SpectatorStatus) {
    if (this.status === status) return;
    this.status = status;
    this.statusListeners.forEach((l) => l(status));
  }

  onStatusChange(listener: Listener<SpectatorStatus>) {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  onReady(listener: Listener<{ title: string; icon: string }>) {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  onError(listener: Listener<string>) {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  destroy() {
    this.socket.off();
    this.socket.disconnect();
    this.doc.destroy();
    this.statusListeners.clear();
    this.readyListeners.clear();
    this.errorListeners.clear();
  }
}
