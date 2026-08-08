export interface PlayerSnapshot {
  position: number;
}

export function restoreState(snapshot: PlayerSnapshot): PlayerSnapshot {
  return { position: snapshot.position };
}
