// "What changed since I was last here" — a small, honest use of two
// different techniques for two different jobs:
//
// 1. A cheap *existence* check via a real Yjs state vector
//    (Y.encodeStateVector): tiny (tens of bytes) and lets us ask "is there
//    anything at all I haven't seen?" without touching document content —
//    a genuinely useful, under-used piece of the Yjs API most collab-editor
//    integrations never reach for.
// 2. The actual *visual* diff is computed from a full plaintext snapshot
//    stored alongside it, using a plain LCS line diff. We could instead
//    try to decode Y.encodeStateAsUpdate(doc, oldStateVector) — the update
//    containing just the "new" operations — but applying a partial update
//    like that onto an empty doc integrates structurally without its
//    surrounding old context, so the reconstructed text isn't reliably in
//    the right relative order. Diffing two full snapshots is simple to get
//    right; that correctness is worth more here than the smaller storage
//    footprint a state-vector-only approach would give us.
import * as Y from "yjs";

const STORAGE_PREFIX = "mgd-lastvisit-";
// Below this, a visit-to-visit gap is almost certainly just a page reload
// or a quick tab-away, not a meaningful "someone else changed this while
// I was gone" — skip the banner to avoid noise.
const MIN_GAP_MS = 60_000;

interface StoredVisit {
  plaintext: string;
  stateVector: string; // base64
  ts: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function saveVisitSnapshot(docId: string, doc: Y.Doc): void {
  try {
    const record: StoredVisit = {
      plaintext: doc.getText("quill").toString(),
      stateVector: bytesToBase64(Y.encodeStateVector(doc)),
      ts: Date.now(),
    };
    localStorage.setItem(STORAGE_PREFIX + docId, JSON.stringify(record));
  } catch {
    // Private browsing / storage disabled — just means no banner next time.
  }
}

function loadVisitSnapshot(docId: string): StoredVisit | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + docId);
    if (!raw) return null;
    return JSON.parse(raw) as StoredVisit;
  } catch {
    return null;
  }
}

export interface DiffLine {
  type: "same" | "add" | "del";
  text: string;
}

/** Standard LCS-based line diff — O(n·m); guarded below for pathologically large documents. */
function lcsLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n * m > 4_000_000) {
    // Too large to diff line-by-line cheaply for a demo feature — fall
    // back to a coarse "everything changed" view rather than hanging.
    return [
      ...oldLines.map((text): DiffLine => ({ type: "del", text })),
      ...newLines.map((text): DiffLine => ({ type: "add", text })),
    ];
  }

  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      result.push({ type: "same", text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      result.push({ type: "del", text: oldLines[i] });
      i++;
    } else {
      result.push({ type: "add", text: newLines[j] });
      j++;
    }
  }
  while (i < n) result.push({ type: "del", text: oldLines[i++] });
  while (j < m) result.push({ type: "add", text: newLines[j++] });
  return result;
}

export interface VisitDiff {
  diff: DiffLine[];
  since: number; // ms timestamp of the stored visit
  addedLines: number;
  removedLines: number;
}

/** Compares the current live doc against the last stored visit snapshot, if any qualifies. Cheap state-vector check first, full diff only if that says something actually changed. */
export function checkForChangesSinceLastVisit(docId: string, doc: Y.Doc): VisitDiff | null {
  const stored = loadVisitSnapshot(docId);
  if (!stored) return null;
  if (Date.now() - stored.ts < MIN_GAP_MS) return null;

  try {
    const oldVector = base64ToBytes(stored.stateVector);
    const delta = Y.encodeStateAsUpdate(doc, oldVector);
    if (delta.length === 0) return null; // nothing new by Yjs's own accounting
  } catch {
    // A state vector from an incompatible/corrupted stored record — treat
    // as "unknown", not as "changed".
    return null;
  }

  const newPlaintext = doc.getText("quill").toString();
  if (newPlaintext === stored.plaintext) return null;

  const diff = lcsLineDiff(stored.plaintext.split("\n"), newPlaintext.split("\n"));
  const addedLines = diff.filter((d) => d.type === "add").length;
  const removedLines = diff.filter((d) => d.type === "del").length;
  if (addedLines === 0 && removedLines === 0) return null;

  return { diff, since: stored.ts, addedLines, removedLines };
}
