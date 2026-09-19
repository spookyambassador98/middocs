import { Avatar } from "../components/Avatar";
import type { PeerState } from "./useAwarenessStates";

export function PresenceStack({ peers }: { peers: PeerState[] }) {
  if (peers.length === 0) return null;
  return (
    <div className="presence-stack">
      {peers.slice(0, 6).map((peer) => (
        <Avatar
          key={peer.clientId}
          name={peer.user!.name}
          color={peer.user!.color}
          size={30}
          title={peer.user!.name}
        />
      ))}
    </div>
  );
}

export function TypingStrip({ peers }: { peers: PeerState[] }) {
  const typingNames = peers.filter((p) => p.typing).map((p) => p.user!.name);
  if (typingNames.length === 0) return <div className="typing-strip" />;

  const label =
    typingNames.length === 1
      ? `${typingNames[0]} печатает`
      : typingNames.length === 2
      ? `${typingNames[0]} и ${typingNames[1]} печатают`
      : `${typingNames.length} человек печатают`;

  return (
    <div className="typing-strip">
      <span className="typing-dots">
        <span />
        <span />
        <span />
      </span>
      {label}…
    </div>
  );
}
