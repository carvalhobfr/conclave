import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { ModelProfile } from "../domain/adaptive-reasoning.js";
import type { AgentAssignment, AgentRole, ReasoningPreset } from "../domain/reasoning.js";
import { assertFreeModelAllowed, DEFAULT_FREE_REASONING_MODELS } from "./free-mode-config.js";

export interface ReasoningConfiguration {
  readonly preset: ReasoningPreset;
  readonly assignments: readonly AgentAssignment[];
  readonly modelProfiles: readonly ModelProfile[];
  readonly fallbackPolicy: "disabled" | "configured";
}

export class ReasoningConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReasoningConfigurationError";
  }
}

const CORE_ROLES: readonly AgentRole[] = ["investigator", "skeptic", "architect", "verifier", "judge"];

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function presetFor(config: RuntimeConfig, environment: NodeJS.ProcessEnv): ReasoningPreset {
  const requested = nonEmpty(environment["CONCLAVE_REASONING_PRESET"]);
  if (requested !== undefined) {
    if (requested !== "free-like" && requested !== "full" && requested !== "local") {
      throw new ReasoningConfigurationError(`Unknown reasoning preset: ${requested}`);
    }
    if (requested === "local" && config.mode !== "local") {
      throw new ReasoningConfigurationError("The local reasoning preset requires Local Mode");
    }
    return requested;
  }
  return config.mode === "free" ? "free-like" : config.mode === "local" ? "local" : "full";
}

function configuredModelProfiles(value: string | undefined): readonly ModelProfile[] {
  if (nonEmpty(value) === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value as string);
  } catch {
    throw new ReasoningConfigurationError("CONCLAVE_MODEL_PROFILES_JSON must be valid JSON");
  }
  if (!Array.isArray(parsed)) throw new ReasoningConfigurationError("CONCLAVE_MODEL_PROFILES_JSON must be a JSON array");
  const levels = new Set(["low", "medium", "high"]);
  const speeds = new Set(["fast", "medium", "slow"]);
  const contexts = new Set(["small", "medium", "large"]);
  const costs = new Set(["free", "standard", "premium"]);
  return parsed.map((candidate, index) => {
    if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
      throw new ReasoningConfigurationError(`Model profile ${String(index)} must be an object`);
    }
    const profile = candidate as Record<string, unknown>;
    const capabilities = profile["capabilities"];
    if (typeof capabilities !== "object" || capabilities === null || Array.isArray(capabilities)) {
      throw new ReasoningConfigurationError(`Model profile ${String(index)} requires capabilities`);
    }
    const caps = capabilities as Record<string, unknown>;
    if (typeof profile["providerId"] !== "string" || typeof profile["modelId"] !== "string"
      || !levels.has(caps["reasoning"] as string) || !levels.has(caps["coding"] as string)
      || !speeds.has(caps["speed"] as string) || !contexts.has(caps["context"] as string)
      || !costs.has(profile["costClass"] as string)
      || (profile["available"] !== undefined && typeof profile["available"] !== "boolean")) {
      throw new ReasoningConfigurationError(`Model profile ${String(index)} has invalid capability fields`);
    }
    return candidate as ModelProfile;
  });
}

export function loadReasoningConfiguration(
  runtime: RuntimeConfig,
  environment: NodeJS.ProcessEnv = process.env,
): ReasoningConfiguration {
  const defaultModel = runtime.providerSelection.model;
  if (defaultModel === undefined) {
    throw new ReasoningConfigurationError("A model is required for reasoning");
  }
  const conductorConfigured = nonEmpty(environment["CONCLAVE_CONDUCTOR_MODEL"]) !== undefined ||
    nonEmpty(environment["CONCLAVE_CONDUCTOR_PROVIDER"]) !== undefined ||
    nonEmpty(environment["CONCLAVE_ENABLE_CONDUCTOR"]) === "true";
  const roles = conductorConfigured ? (["conductor", ...CORE_ROLES] as const) : CORE_ROLES;
  const modelProfiles = configuredModelProfiles(environment["CONCLAVE_MODEL_PROFILES_JSON"]);
  if (runtime.mode === "free") {
    for (const profile of modelProfiles) assertFreeModelAllowed(profile.modelId, runtime.allowedModels);
  }
  const fallback = nonEmpty(environment["CONCLAVE_MODEL_FALLBACK_POLICY"]) ?? "disabled";
  if (fallback !== "disabled" && fallback !== "configured") {
    throw new ReasoningConfigurationError("CONCLAVE_MODEL_FALLBACK_POLICY must be disabled or configured");
  }
  return {
    preset: presetFor(runtime, environment),
    modelProfiles,
    fallbackPolicy: fallback,
    assignments: roles.map((role) => {
      const prefix = `CONCLAVE_${role.toUpperCase()}`;
      const modelId = nonEmpty(environment[`${prefix}_MODEL`])
        ?? (runtime.mode === "free" ? DEFAULT_FREE_REASONING_MODELS[role] : defaultModel);
      if (runtime.mode === "free") assertFreeModelAllowed(modelId, runtime.allowedModels);
      return {
        role,
        providerId: nonEmpty(environment[`${prefix}_PROVIDER`]) ?? runtime.providerSelection.provider,
        modelId,
      };
    }),
  };
}
