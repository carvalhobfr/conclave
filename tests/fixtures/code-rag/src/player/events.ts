type PlayerEventHandler = (event: Event) => void;

const playerBus = new EventTarget();

export function subscribeToPlayerEvents(
  playerId: string,
  handler: PlayerEventHandler,
): () => void {
  const scopedHandler = (event: Event): void => {
    if ((event as CustomEvent<{ playerId: string }>).detail.playerId === playerId) {
      handler(event);
    }
  };
  playerBus.addEventListener("player:update", scopedHandler);
  return () => playerBus.removeEventListener("player:update", scopedHandler);
}
