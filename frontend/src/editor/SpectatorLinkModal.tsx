import { useState } from "react";
import { api } from "../api/client";

/**
 * Owner-only control for the public "watch live" link (see
 * SpectatorProvider.ts / SpectatePage.tsx for the viewing side). The token
 * itself IS the access grant — there's no login for a spectator — so this
 * modal is really just create/copy/revoke for that one opaque string.
 */
export function SpectatorLinkModal({
  docId,
  initialToken,
  onClose,
  onTokenChange,
}: {
  docId: string;
  initialToken: string | null;
  onClose: () => void;
  onTokenChange: (token: string | null) => void;
}) {
  const [token, setToken] = useState(initialToken);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const link = token ? `${window.location.origin}/watch/${token}` : null;

  async function enable() {
    setBusy(true);
    setError(null);
    try {
      const { token: newToken } = await api.createSpectatorLink(docId);
      setToken(newToken);
      onTokenChange(newToken);
    } catch {
      setError("Could not create the broadcast link");
    } finally {
      setBusy(false);
    }
  }

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api.revokeSpectatorLink(docId);
      setToken(null);
      onTokenChange(null);
    } catch {
      setError("Could not turn the broadcast off");
    } finally {
      setBusy(false);
    }
  }

  function copyLink() {
    if (!link) return;
    void navigator.clipboard?.writeText(link);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="drawer-overlay" onMouseDown={onClose}>
      <div className="history-drawer spectator-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="history-drawer-header">
          <h2>Live broadcast</h2>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <p className="notary-intro">
          A public link with no account. Anyone with it can watch the document
          and the edits as they happen, and cannot change anything. This is a
          narrower door than the edit link.
        </p>

        {error && <div className="form-error">{error}</div>}

        {link ? (
          <>
            <div className="spectator-link-row">
              <input
                className="spectator-link-input"
                value={link}
                readOnly
                onFocus={(e) => e.target.select()}
              />
              <button className="btn btn-primary" style={{ width: "auto" }} onClick={copyLink}>
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <div className="history-drawer-actions">
              <button className="btn btn-danger-ghost" onClick={() => void revoke()} disabled={busy}>
                {busy ? "Turning off…" : "Turn broadcast off"}
              </button>
            </div>
          </>
        ) : (
          <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => void enable()} disabled={busy}>
            {busy ? "Creating…" : "Start broadcast"}
          </button>
        )}
      </div>
    </div>
  );
}
