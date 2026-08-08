export function registerAnalyticsListener(): void {
  window.addEventListener("player:update", () => {
    navigator.sendBeacon("/analytics/player-update");
  });
}
