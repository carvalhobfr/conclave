import { useEffect } from "react";

import { subscribeToPlayerEvents } from "./events";

export function usePlayerEvents(playerId: string, onUpdate: (event: Event) => void): void {
  useEffect(() => {
    const unsubscribe = subscribeToPlayerEvents(playerId, onUpdate);
    return () => unsubscribe();
  }, [playerId, onUpdate]);
}
