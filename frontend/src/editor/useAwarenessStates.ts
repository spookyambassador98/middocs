import { useEffect, useState } from "react";
import type { Awareness } from "y-protocols/awareness.js";

export interface PeerState {
  clientId: number;
  user?: { name: string; color: string };
  typing?: boolean;
}

export function useAwarenessStates(awareness: Awareness | null, localClientId: number | null): PeerState[] {
  const [peers, setPeers] = useState<PeerState[]>([]);

  useEffect(() => {
    if (!awareness) return;

    const sync = () => {
      const next: PeerState[] = [];
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === localClientId) return;
        if (!state?.user) return; // not fully joined yet
        next.push({ clientId, user: state.user, typing: Boolean(state.typing) });
      });
      setPeers(next);
    };

    sync();
    awareness.on("change", sync);
    return () => awareness.off("change", sync);
  }, [awareness, localClientId]);

  return peers;
}
