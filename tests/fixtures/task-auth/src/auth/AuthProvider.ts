export type Session = { token: string };

export function bootstrapSession(setSession: (session: Session | null) => void): void {
  // Refresh currently starts from an empty session instead of restoring storage.
  setSession(null);
}

export function initializeAuth(setSession: (session: Session | null) => void): void {
  bootstrapSession(setSession);
}
