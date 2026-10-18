import { useEffect, useState } from "react";
import { api, type ApiNotaryEntry } from "../api/client";
import { verifyNotaryChain, type NotaryVerification } from "./notary";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortHash(hash: string | null): string {
  if (!hash) return "—";
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`;
}

/**
 * Notary drawer — shows a document's notary hash-chain (see notary.ts) and
 * lets the person actually verify it themselves, client-side, rather than
 * just trust a green checkmark someone else computed. Deliberately styled
 * like a git log / blockchain explorer: each entry shows what it chains
 * from and to, so the mechanism is visible, not just the verdict.
 */
export function NotaryDrawer({ docId, onClose }: { docId: string; onClose: () => void }) {
  const [chain, setChain] = useState<ApiNotaryEntry[] | null>(null);
  const [verification, setVerification] = useState<NotaryVerification | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHashes, setShowHashes] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .getNotaryChain(docId)
      .then(({ chain: fetched }) => {
        if (!cancelled) setChain(fetched);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the version chain");
      });
    return () => {
      cancelled = true;
    };
  }, [docId]);

  async function runVerify() {
    if (!chain) return;
    setVerifying(true);
    try {
      const result = await verifyNotaryChain(docId, chain);
      setVerification(result);
    } finally {
      setVerifying(false);
    }
  }

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <div className="history-drawer notary-drawer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-drawer-header">
          <h2>Notary: version chain</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="form-error">{error}</div>}

        {!chain ? (
          <div className="editor-loading" style={{ height: 160 }}>
            <div className="spinner" />
          </div>
        ) : (
          <>
            <p className="notary-intro">
              Each checkpoint is hash-linked to the one before it, the same way git commits are.
              The check below recomputes the whole chain in the browser. If one record was
              altered, reordered, or deleted after the fact, every hash after it would stop matching.
            </p>

            <div className="notary-actions">
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => void runVerify()} disabled={verifying}>
                {verifying ? "Checking…" : "Check integrity"}
              </button>
              <button className="btn btn-ghost" onClick={() => setShowHashes((s) => !s)}>
                {showHashes ? "Hide hashes" : "Show hashes"}
              </button>
            </div>

            {verification && (
              <div className={`notary-verdict ${verification.ok ? "ok" : "broken"}`}>
                {verification.ok
                  ? `Chain is intact. Records checked: ${verification.checked}${
                      verification.legacyCount ? ` (+${verification.legacyCount} from before the notary, with no hashes)` : ""
                    }.`
                  : `Mismatch starting at record ${(verification.brokenAtIndex ?? 0) + 1}. The history may have been changed after the fact.`}
              </div>
            )}

            <div className="notary-chain">
              {chain.length === 0 && <p className="comments-empty">No checkpoints yet.</p>}
              {chain.map((entry, i) => {
                const legacy = !entry.chainHash;
                const broken = Boolean(verification && !verification.ok && verification.brokenAtIndex === i);
                return (
                  <div key={entry.id} className={`notary-entry ${broken ? "broken" : ""} ${legacy ? "legacy" : ""}`}>
                    <div className="notary-entry-index">#{i + 1}</div>
                    <div className="notary-entry-body">
                      <div className="notary-entry-head">
                        <span className="notary-entry-time">{formatTime(entry.createdAt)}</span>
                        <span className="notary-entry-author">
                          {entry.authorSummary ?? (legacy ? "before the notary" : "Automatic checkpoint")}
                        </span>
                      </div>
                      {showHashes && (
                        <div className="notary-entry-hashes">
                          <span>prev: {shortHash(entry.prevChainHash)}</span>
                          <span>hash: {shortHash(entry.chainHash)}</span>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
