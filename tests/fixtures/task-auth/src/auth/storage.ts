let token: string | null = null;

export function persistToken(nextToken: string): void {
  token = nextToken;
}

export function getStoredToken(): string | null {
  return token;
}
