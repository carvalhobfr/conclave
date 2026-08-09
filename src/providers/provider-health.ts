export interface ProviderHealthView {
  readonly providerId: string;
  readonly modelId: string;
  readonly recentSuccesses: number;
  readonly recentFailures: number;
  readonly recentLatencyMs: number;
  readonly state: "healthy" | "degraded" | "unavailable";
}

interface Observation {
  readonly success: boolean;
  readonly latencyMs: number;
}

export class ProviderHealthTracker {
  readonly #observations = new Map<string, Observation[]>();
  readonly #windowSize: number;

  public constructor(windowSize = 8) {
    this.#windowSize = Math.max(1, Math.min(Math.floor(windowSize), 50));
  }

  public record(providerId: string, modelId: string, success: boolean, latencyMs: number): void {
    const key = `${providerId}\0${modelId}`;
    const observations = this.#observations.get(key) ?? [];
    observations.push({ success, latencyMs: Math.max(0, latencyMs) });
    this.#observations.set(key, observations.slice(-this.#windowSize));
  }

  public get(providerId: string, modelId: string): ProviderHealthView {
    const observations = this.#observations.get(`${providerId}\0${modelId}`) ?? [];
    const successes = observations.filter((item) => item.success).length;
    const failures = observations.length - successes;
    const latency = observations.length === 0 ? 0 : observations.reduce((total, item) => total + item.latencyMs, 0) / observations.length;
    const state = observations.length >= 2 && failures === observations.length
      ? "unavailable"
      : failures >= 2 && failures >= successes ? "degraded" : "healthy";
    return { providerId, modelId, recentSuccesses: successes, recentFailures: failures, recentLatencyMs: latency, state };
  }

  public all(): readonly ProviderHealthView[] {
    return [...this.#observations.keys()].map((key) => {
      const [providerId = "", modelId = ""] = key.split("\0");
      return this.get(providerId, modelId);
    });
  }
}
