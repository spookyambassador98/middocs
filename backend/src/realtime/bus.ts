// A thin Redis pub/sub layer that keeps every backend instance's in-memory
// Yjs state (documents + presence/awareness) consistent with every other
// instance. This is distinct from (and in addition to) the Socket.io Redis
// adapter set up in socket.ts: the adapter makes `io.to(room).emit(...)`
// deliver to browsers connected to *any* instance, but it never touches
// server-side application state. Without this bus, an instance that a
// client hasn't touched would have a stale in-memory Y.Doc and could hand
// a newly-joining client (or a debounced Postgres write) an out-of-date
// document.
import { createClient } from "redis";
import { config } from "../config.js";

export const CHANNEL = "yjs-bus";

type BusMessageType = "sync" | "awareness";

interface BusMessage {
  instanceId: string;
  docId: string;
  type: BusMessageType;
  payload: string; // base64-encoded Uint8Array
}

export type BusHandler = (docId: string, type: BusMessageType, payload: Uint8Array) => void;

export async function createBus(handler: BusHandler) {
  const publisher = createClient({ url: config.redisUrl });
  const subscriber = publisher.duplicate();

  publisher.on("error", (err) => console.error("[redis:pub] error", err));
  subscriber.on("error", (err) => console.error("[redis:sub] error", err));

  await Promise.all([publisher.connect(), subscriber.connect()]);

  await subscriber.subscribe(CHANNEL, (message) => {
    let parsed: BusMessage;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed.instanceId === config.instanceId) return; // ignore our own publishes
    handler(parsed.docId, parsed.type, Buffer.from(parsed.payload, "base64"));
  });

  function publish(docId: string, type: BusMessageType, payload: Uint8Array) {
    const message: BusMessage = {
      instanceId: config.instanceId,
      docId,
      type,
      payload: Buffer.from(payload).toString("base64"),
    };
    publisher.publish(CHANNEL, JSON.stringify(message)).catch((err) => {
      console.error("[redis:pub] publish failed", err);
    });
  }

  async function close() {
    await subscriber.unsubscribe(CHANNEL);
    await Promise.all([publisher.quit(), subscriber.quit()]);
  }

  return { publish, close };
}
