// A small, from-scratch peer-to-peer resilience layer: browsers editing
// the same document additionally connect DIRECTLY to each other over
// WebRTC data channels, signaled through the existing Socket.io
// connection (see SocketIOProvider.ts and the backend's "webrtc-signal"
// relay in socket.ts). Every Yjs update still goes through the server as
// normal — this is purely supplementary — but once a data channel is
// open, updates also flow peer-to-peer, so a brief server hiccup (a
// reconnect, a rolling deploy of one backend instance) doesn't interrupt
// sync between collaborators who are already meshed together. This is
// possible at all only because Yjs updates are commutative and
// idempotent: applying the same bytes twice (once from the server, once
// from a direct peer) is a harmless no-op, so there's no need to
// deduplicate or coordinate which path "wins".
//
// This is a small full mesh (every browser connects to every other one
// directly), which is the right trade-off for a handful of concurrent
// editors on one document — a real production system with dozens of
// simultaneous editors on one document would want an SFU instead of an
// O(n²) mesh; out of scope for a demo of the underlying idea.
//
// No signaling library, no y-webrtc — just RTCPeerConnection plus a tiny
// hand-rolled negotiation protocol over whatever `sendSignal` is wired to.

const ICE_SERVERS: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];

export type WireSignal =
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string }
  | { type: "candidate"; candidate: RTCIceCandidateInit };

interface PeerEntry {
  pc: RTCPeerConnection;
  channel: RTCDataChannel | null;
}

export function isWebRtcMeshSupported(): boolean {
  return typeof RTCPeerConnection !== "undefined";
}

export class WebRtcMesh {
  private peers = new Map<number, PeerEntry>();
  private peerCountListeners = new Set<(count: number) => void>();

  constructor(
    private localClientId: number,
    private sendSignal: (toClientId: number, signal: WireSignal) => void,
    private onData: (bytes: Uint8Array, fromClientId: number) => void,
    private onPeerOpen: (remoteClientId: number) => void
  ) {}

  /** Called whenever the awareness roster changes: connects to any new peer we don't already have a connection to, and tears down connections to peers who left. */
  reconcile(peerClientIds: number[]): void {
    const wanted = new Set(peerClientIds.filter((id) => id !== this.localClientId));

    for (const id of wanted) {
      if (this.peers.has(id)) continue;
      // Deterministic tie-break so only ONE side of every pair ever calls
      // createOffer — the lower clientID always initiates. This sidesteps
      // "glare" (both sides offering at once) entirely, at the cost of a
      // simplifying assumption (no renegotiation mid-call) that's fine for
      // a demo-scale mesh.
      if (this.localClientId < id) {
        void this.connectTo(id);
      }
      // If we're the higher ID, we just wait for their offer to arrive via
      // receiveSignal — ensurePeer(..., initiator: false) creates our side
      // of the connection lazily, right when that offer shows up.
    }

    for (const id of Array.from(this.peers.keys())) {
      if (!wanted.has(id)) this.dropPeer(id);
    }
  }

  private ensurePeer(remoteClientId: number, initiator: boolean): PeerEntry {
    const existing = this.peers.get(remoteClientId);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const entry: PeerEntry = { pc, channel: null };
    this.peers.set(remoteClientId, entry);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.sendSignal(remoteClientId, { type: "candidate", candidate: event.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed" || pc.connectionState === "disconnected") {
        this.dropPeer(remoteClientId);
      }
    };

    if (initiator) {
      const channel = pc.createDataChannel("yjs-sync");
      this.wireChannel(remoteClientId, entry, channel);
    } else {
      pc.ondatachannel = (event) => this.wireChannel(remoteClientId, entry, event.channel);
    }

    return entry;
  }

  private wireChannel(remoteClientId: number, entry: PeerEntry, channel: RTCDataChannel): void {
    entry.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      this.notifyPeerCountChange();
      this.onPeerOpen(remoteClientId);
    };
    channel.onclose = () => this.dropPeer(remoteClientId);
    channel.onerror = () => this.dropPeer(remoteClientId);
    channel.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.onData(new Uint8Array(event.data), remoteClientId);
      }
    };
  }

  private async connectTo(remoteClientId: number): Promise<void> {
    try {
      const entry = this.ensurePeer(remoteClientId, true);
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      this.sendSignal(remoteClientId, { type: "offer", sdp: offer.sdp ?? "" });
    } catch (err) {
      console.warn("[webrtcMesh] failed to initiate connection", err);
      this.dropPeer(remoteClientId);
    }
  }

  /** Feeds an incoming offer/answer/ICE-candidate relayed by the server (see SocketIOProvider's "webrtc-signal" listener) into the right peer connection, creating it lazily if this is the first we've heard of that peer. */
  async receiveSignal(fromClientId: number, signal: WireSignal): Promise<void> {
    try {
      if (signal.type === "offer") {
        const entry = this.ensurePeer(fromClientId, false);
        await entry.pc.setRemoteDescription({ type: "offer", sdp: signal.sdp });
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        this.sendSignal(fromClientId, { type: "answer", sdp: answer.sdp ?? "" });
      } else if (signal.type === "answer") {
        const entry = this.peers.get(fromClientId);
        if (!entry) return;
        await entry.pc.setRemoteDescription({ type: "answer", sdp: signal.sdp });
      } else if (signal.type === "candidate") {
        const entry = this.peers.get(fromClientId);
        if (!entry) return;
        await entry.pc.addIceCandidate(signal.candidate);
      }
    } catch (err) {
      console.warn("[webrtcMesh] failed to process signal", err);
    }
  }

  /** Fans a Yjs update's on-wire bytes (already encrypted, if this is a zero-knowledge document — see SocketIOProvider) out to every peer with an open data channel. Best-effort: the server-relayed path is always the source of truth. */
  send(bytes: Uint8Array): void {
    for (const entry of this.peers.values()) {
      if (entry.channel?.readyState === "open") {
        try {
          entry.channel.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        } catch (err) {
          console.warn("[webrtcMesh] failed to send over data channel", err);
        }
      }
    }
  }

  /** Targeted send to exactly one peer — used for the one-time "here's my full current state" handshake right after a data channel opens, rather than broadcasting it to everyone every time any one peer joins. */
  sendTo(remoteClientId: number, bytes: Uint8Array): void {
    const entry = this.peers.get(remoteClientId);
    if (entry?.channel?.readyState === "open") {
      try {
        entry.channel.send(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
      } catch (err) {
        console.warn("[webrtcMesh] failed to send handshake over data channel", err);
      }
    }
  }

  openPeerCount(): number {
    let count = 0;
    for (const entry of this.peers.values()) {
      if (entry.channel?.readyState === "open") count++;
    }
    return count;
  }

  onPeerCountChange(listener: (count: number) => void): () => void {
    this.peerCountListeners.add(listener);
    return () => this.peerCountListeners.delete(listener);
  }

  private notifyPeerCountChange(): void {
    const count = this.openPeerCount();
    this.peerCountListeners.forEach((l) => l(count));
  }

  private dropPeer(id: number): void {
    const entry = this.peers.get(id);
    if (!entry) return;
    try {
      entry.channel?.close();
    } catch {
      // already closed — fine
    }
    try {
      entry.pc.close();
    } catch {
      // already closed — fine
    }
    this.peers.delete(id);
    this.notifyPeerCountChange();
  }

  destroy(): void {
    for (const id of Array.from(this.peers.keys())) this.dropPeer(id);
    this.peerCountListeners.clear();
  }
}
