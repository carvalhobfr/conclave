let storedToken: string | null = null;

export function persistToken(token: string): void {
  storedToken = token;
}

export function getStoredToken(): string | null {
  return storedToken;
}
