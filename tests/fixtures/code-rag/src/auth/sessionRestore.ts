export interface AuthSessionSnapshot {
  token: string;
  userId: string;
}

export function restoreState(snapshot: AuthSessionSnapshot): AuthSessionSnapshot {
  return { token: snapshot.token, userId: snapshot.userId };
}
