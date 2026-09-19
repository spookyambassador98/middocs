import { useState } from "react";

interface ShareLiveProjectButtonProps {
  /** URL to share. Defaults to the live app origin. */
  url?: string;
  className?: string;
}

export function ShareLiveProjectButton({ url, className = "btn btn-ghost" }: ShareLiveProjectButtonProps) {
  const [feedback, setFeedback] = useState<string | null>(null);

  async function handleShare() {
    const shareUrl = url ?? window.location.origin;
    const title = "middocs — live project";
    const text = "Collaborative docs in real time";

    try {
      if (navigator.share) {
        await navigator.share({ title, text, url: shareUrl });
        return;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }

    try {
      await navigator.clipboard.writeText(shareUrl);
      setFeedback("Copied!");
    } catch {
      setFeedback("Copy failed");
    }

    window.setTimeout(() => setFeedback(null), 2000);
  }

  return (
    <button type="button" className={className} onClick={() => void handleShare()} title="Share live project">
      <ShareIcon />
      {feedback ?? "Share live project"}
    </button>
  );
}

function ShareIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v14"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
