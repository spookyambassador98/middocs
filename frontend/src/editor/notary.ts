// Client-side half of the notary hash-chain (see backend service.ts's
// insertSnapshot and schema.sql's comment on document_snapshots). The
// server hands over only metadata — timestamps, an author summary string,
// and a hash of the snapshot's own bytes — never the actual document
// content, so this is cheap to fetch and safe even for an encrypted
// document (state_hash there is a hash of ciphertext, still verifiable
// the same way, still never decoded by anyone without the key).
//
// This file recomputes every link of the chain independently, using the
// same WebCrypto SHA-256 primitive as everything else in this app, and
// compares the result against what the server claims. If a snapshot row
// had ever been silently edited, reordered, or deleted-and-reinserted by
// someone with raw database access, every hash from that point forward
// would stop matching — the same tamper-evidence property a git commit
// graph or a blockchain gives you, recomputed entirely in the browser.
import type { ApiNotaryEntry } from "../api/client";

export const GENESIS_HASH = "0".repeat(64);

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface NotaryVerification {
  ok: boolean;
  checked: number;
  legacyCount: number;
  brokenAtIndex: number | null;
}

/**
 * Verifies a document's whole notary chain, oldest entry first. Entries
 * from before this feature existed (chain_hash/state_hash null, on a
 * Postgres volume upgraded via `npm run migrate`) are counted separately
 * as "legacy" and skipped rather than treated as a broken link — but the
 * very next entry that *does* have a real hash still has to chain
 * correctly from GENESIS_HASH (or from wherever verification last saw a
 * real hash), so a legacy prefix can't be used to smuggle in a forged
 * first "real" entry either.
 */
export async function verifyNotaryChain(documentId: string, chain: ApiNotaryEntry[]): Promise<NotaryVerification> {
  let prevHash = GENESIS_HASH;
  let checked = 0;
  let legacyCount = 0;

  for (let i = 0; i < chain.length; i++) {
    const entry = chain[i];
    if (!entry.chainHash || !entry.stateHash) {
      legacyCount += 1;
      continue;
    }
    if (entry.prevChainHash !== null && entry.prevChainHash !== prevHash) {
      return { ok: false, checked, legacyCount, brokenAtIndex: i };
    }
    const expected = await sha256Hex(
      `${prevHash}:${documentId}:${entry.createdAt}:${entry.authorSummary ?? ""}:${entry.stateHash}`
    );
    if (expected !== entry.chainHash) {
      return { ok: false, checked, legacyCount, brokenAtIndex: i };
    }
    checked += 1;
    prevHash = entry.chainHash;
  }

  return { ok: true, checked, legacyCount, brokenAtIndex: null };
}
