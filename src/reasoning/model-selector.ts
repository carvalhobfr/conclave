import type { ModelProfile, ModelRequirement } from "../domain/adaptive-reasoning.js";
import type { AgentAssignment, AgentRole } from "../domain/reasoning.js";
import type { ProviderHealthTracker } from "../providers/provider-health.js";

export interface ModelSelection {
  readonly assignment: AgentAssignment;
  readonly profile?: ModelProfile;
  readonly fallback: boolean;
  readonly reason: string;
}

export interface ModelSelectorOptions {
  readonly profiles: readonly ModelProfile[];
  readonly explicitAssignments?: readonly AgentAssignment[];
  readonly fallbackPolicy?: "disabled" | "configured";
  readonly health?: ProviderHealthTracker;
}

const LEVEL = { low: 0, medium: 1, high: 2 } as const;
const CONTEXT = { small: 0, medium: 1, large: 2 } as const;
const SPEED = { fast: 0, medium: 1, slow: 2 } as const;

function eligible(profile: ModelProfile, requirement: ModelRequirement): boolean {
  if (profile.available === false) return false;
  if (requirement.costPreference === "free-only" && profile.costClass !== "free") return false;
  if (requirement.reasoning !== undefined && LEVEL[profile.capabilities.reasoning] < LEVEL[requirement.reasoning]) return false;
  if (requirement.coding !== undefined && LEVEL[profile.capabilities.coding] < LEVEL[requirement.coding]) return false;
  if (requirement.context !== undefined && CONTEXT[profile.capabilities.context] < CONTEXT[requirement.context]) return false;
  if (requirement.speed === "interactive" && profile.capabilities.speed !== "fast") return false;
  return true;
}

function profileScore(profile: ModelProfile, requirement: ModelRequirement, latencyMs: number): number {
  const cost = profile.costClass === "free" ? 0 : profile.costClass === "standard" ? 2 : 4;
  const speed = SPEED[profile.capabilities.speed] * (requirement.speed === "interactive" ? 5 : 1);
  const costPreference = requirement.costPreference === "prefer-free" ? cost * 3 : cost;
  return speed + costPreference + latencyMs / 10_000;
}

export class ModelSelector {
  readonly #profiles: readonly ModelProfile[];
  readonly #explicit: ReadonlyMap<AgentRole, AgentAssignment>;
  readonly #fallbackPolicy: "disabled" | "configured";
  readonly #health: ProviderHealthTracker | undefined;

  public constructor(options: ModelSelectorOptions) {
    this.#profiles = options.profiles;
    this.#explicit = new Map((options.explicitAssignments ?? []).map((assignment) => [assignment.role, assignment]));
    this.#fallbackPolicy = options.fallbackPolicy ?? "disabled";
    this.#health = options.health;
  }

  public select(
    role: AgentRole,
    requirement: ModelRequirement = {},
    previousModels: readonly string[] = [],
  ): ModelSelection | undefined {
    const explicit = this.#explicit.get(role);
    if (explicit !== undefined) {
      const profile = this.#profiles.find((item) => item.providerId === explicit.providerId && item.modelId === explicit.modelId);
      const health = this.#health?.get(explicit.providerId, explicit.modelId);
      if (profile?.available !== false && health?.state !== "unavailable") {
        return { assignment: explicit, ...(profile === undefined ? {} : { profile }), fallback: false, reason: "explicit role assignment" };
      }
      if (this.#fallbackPolicy === "disabled") return undefined;
    }
    let candidates = this.#profiles.filter((profile) => eligible(profile, requirement));
    if (requirement.independencePreferred && previousModels.length > 0) {
      const independent = candidates.filter((profile) => !previousModels.includes(`${profile.providerId}:${profile.modelId}`));
      if (independent.length > 0) candidates = independent;
    }
    candidates = candidates.filter((profile) => this.#health?.get(profile.providerId, profile.modelId).state !== "unavailable");
    const selected = [...candidates].sort((left, right) => {
      const leftHealth = this.#health?.get(left.providerId, left.modelId);
      const rightHealth = this.#health?.get(right.providerId, right.modelId);
      const leftPenalty = leftHealth?.state === "degraded" ? 100 : 0;
      const rightPenalty = rightHealth?.state === "degraded" ? 100 : 0;
      return profileScore(left, requirement, leftHealth?.recentLatencyMs ?? 0) + leftPenalty
        - profileScore(right, requirement, rightHealth?.recentLatencyMs ?? 0) - rightPenalty
        || left.providerId.localeCompare(right.providerId) || left.modelId.localeCompare(right.modelId);
    })[0];
    if (selected === undefined) return undefined;
    return {
      assignment: { role, providerId: selected.providerId, modelId: selected.modelId },
      profile: selected,
      fallback: explicit !== undefined,
      reason: explicit === undefined ? "capability and policy match" : "configured fallback after explicit model became unavailable",
    };
  }
}
