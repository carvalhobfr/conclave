export interface UsageRequest {
  readonly clientId: string;
  readonly operation: "ask" | "investigate" | "task";
  readonly units: number;
}

export interface UsageDecision {
  readonly allowed: boolean;
  readonly reason: "authorized" | "quota-exhausted";
  readonly remaining: number;
}

export interface UsageGate {
  authorize(request: UsageRequest): Promise<UsageDecision>;
}

interface UsageWindow {
  startedAt: number;
  used: number;
}

export class InMemoryUsageGate implements UsageGate {
  readonly #quota: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #usage = new Map<string, UsageWindow>();

  public constructor(options: { readonly quota: number; readonly windowMs: number; readonly now?: () => number }) {
    if (!Number.isInteger(options.quota) || options.quota < 1) throw new Error("Usage quota must be a positive integer");
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) throw new Error("Usage window must be a positive integer");
    this.#quota = options.quota;
    this.#windowMs = options.windowMs;
    this.#now = options.now ?? Date.now;
  }

  public authorize(request: UsageRequest): Promise<UsageDecision> {
    if (!Number.isInteger(request.units) || request.units < 1) return Promise.resolve({ allowed: false, reason: "quota-exhausted", remaining: 0 });
    const now = this.#now();
    const current = this.#usage.get(request.clientId);
    const window = current === undefined || now - current.startedAt >= this.#windowMs
      ? { startedAt: now, used: 0 }
      : current;
    const remaining = Math.max(0, this.#quota - window.used);
    if (request.units > remaining) return Promise.resolve({ allowed: false, reason: "quota-exhausted", remaining });
    window.used += request.units;
    this.#usage.set(request.clientId, window);
    return Promise.resolve({ allowed: true, reason: "authorized", remaining: this.#quota - window.used });
  }
}

export class FreeUsageError extends Error {
  public constructor(public readonly code: "model_not_allowed" | "concurrency_limit" | "quota_exhausted", message: string) {
    super(message);
    this.name = "FreeUsageError";
  }
}

export class FreeUsageController {
  readonly #allowedModels: ReadonlySet<string>;
  readonly #gate: UsageGate;
  readonly #maxConcurrency: number;
  #active = 0;

  public constructor(options: { readonly allowedModels: readonly string[]; readonly gate: UsageGate; readonly maxConcurrency: number }) {
    if (options.allowedModels.length === 0) throw new Error("Free model allowlist cannot be empty");
    if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) throw new Error("Free concurrency must be a positive integer");
    this.#allowedModels = new Set(options.allowedModels);
    this.#gate = options.gate;
    this.#maxConcurrency = options.maxConcurrency;
  }

  public async run<T>(
    request: Omit<UsageRequest, "units"> & { readonly models: readonly string[] },
    operation: () => Promise<T>,
  ): Promise<T> {
    const unsupported = request.models.find((model) => !this.#allowedModels.has(model));
    if (unsupported !== undefined) throw new FreeUsageError("model_not_allowed", `Configured Free model ${unsupported} is not allowed by the host.`);
    if (this.#active >= this.#maxConcurrency) throw new FreeUsageError("concurrency_limit", "Free Mode concurrency limit reached. Try again after an active run finishes.");
    this.#active += 1;
    try {
      const decision = await this.#gate.authorize({ clientId: request.clientId, operation: request.operation, units: 1 });
      if (!decision.allowed) throw new FreeUsageError("quota_exhausted", "Free Mode quota is exhausted for the current window.");
      return await operation();
    } finally {
      this.#active -= 1;
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

export function createFreeUsageController(environment: NodeJS.ProcessEnv, allowedModels: readonly string[]): FreeUsageController {
  const quota = positiveInteger(environment["CONCLAVE_FREE_REQUESTS_PER_WINDOW"], 20, "CONCLAVE_FREE_REQUESTS_PER_WINDOW");
  const windowMs = positiveInteger(environment["CONCLAVE_FREE_WINDOW_MS"], 3_600_000, "CONCLAVE_FREE_WINDOW_MS");
  const maxConcurrency = positiveInteger(environment["CONCLAVE_FREE_MAX_CONCURRENCY"], 2, "CONCLAVE_FREE_MAX_CONCURRENCY");
  return new FreeUsageController({ allowedModels, gate: new InMemoryUsageGate({ quota, windowMs }), maxConcurrency });
}
