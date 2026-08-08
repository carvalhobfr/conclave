import { persistToken } from "./storage";

export function completeLogin(token: string): void {
  persistToken(token);
}
