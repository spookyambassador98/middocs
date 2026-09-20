// Zero-knowledge document encryption. Everything here runs in the browser
// via the standard WebCrypto API (AES-256-GCM) — the server never sees a
// key, a plaintext byte, or a call into this file. The key lives only in
// the URL fragment (`#key=...`), which browsers never include in requests
// they send to a server, so whoever holds the full link can decrypt the
// document and no one else can — including us.
//
// What's encrypted: everything that lives inside the document's Yjs
// content — text, title (stored in the shared "meta" map), comments. What
// is NOT encrypted, as an explicit and documented trade-off: presence
// metadata (display name, cursor color, typing indicator) sent over
// awareness, because the server legitimately needs to relay that live to
// render collaborator avatars/cursors, the same trade-off most E2E chat
// apps make for typing indicators and read receipts.

const IV_LENGTH = 12; // bytes, standard for AES-GCM

export async function generateDocumentKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

export async function importDocumentKey(rawUrlSafeBase64: string): Promise<CryptoKey> {
  const raw = base64UrlToBytes(rawUrlSafeBase64);
  return crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
}

export async function exportDocumentKey(key: CryptoKey): Promise<string> {
  const raw = await crypto.subtle.exportKey("raw", key);
  return bytesToBase64Url(new Uint8Array(raw));
}

/** IV (12 bytes) prefixed to the ciphertext, as one blob — the whole point being that this is a single opaque Uint8Array from the server's perspective. */
export async function encryptBytes(key: CryptoKey, plaintext: Uint8Array): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(plaintext));
  const combined = new Uint8Array(IV_LENGTH + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), IV_LENGTH);
  return combined;
}

export async function decryptBytes(key: CryptoKey, combined: Uint8Array): Promise<Uint8Array> {
  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, toArrayBuffer(ciphertext));
  return new Uint8Array(plaintext);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // Guarantees a real standalone ArrayBuffer (not a view into a larger
  // pooled buffer with extra bytes on either side), which is what
  // SubtleCrypto expects.
  return bytes.slice().buffer;
}

// ---------- base64 helpers ----------

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(urlSafe: string): Uint8Array {
  const base64 = urlSafe.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return base64ToBytes(padded);
}
