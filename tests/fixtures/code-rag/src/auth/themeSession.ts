export function bootstrapThemeSession(): string {
  return localStorage.getItem("theme") ?? "system";
}
