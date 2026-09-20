// Caches a zero-knowledge document's decryption key in this browser's
// localStorage, keyed by document id, so returning to the dashboard and
// clicking the card again still works without the full #key=... link
// having to be pasted in every time. This is a convenience cache only —
// it never leaves this browser, was never sent to (or readable by) the
// server, and a brand-new browser/device still needs the full link (or a
// manually pasted key) at least once, exactly like e.g. Firefox Send or
// Standard Notes-style zero-knowledge sharing.
const PREFIX = "mgd-key-";

export function cacheDocumentKey(docId: string, keyStr: string): void {
  try {
    localStorage.setItem(PREFIX + docId, keyStr);
  } catch {
    // Private browsing / storage disabled — the key still works for this
    // tab's session, it just won't be remembered next visit.
  }
}

export function getCachedDocumentKey(docId: string): string | null {
  try {
    return localStorage.getItem(PREFIX + docId);
  } catch {
    return null;
  }
}
