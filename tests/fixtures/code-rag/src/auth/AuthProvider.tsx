import { useEffect, useState } from "react";

import { getStoredToken } from "./storage";

type Session = { token: string };

export function bootstrapSession(setSession: (session: Session | null) => void): void {
  const persistedToken = getStoredToken();
  if (persistedToken === null) {
    setSession(null);
    return;
  }
  setSession({ token: persistedToken });
}

export function AuthProvider(): JSX.Element {
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    bootstrapSession(setSession);
  }, []);

  return <main data-authenticated={session !== null}>Application</main>;
}
