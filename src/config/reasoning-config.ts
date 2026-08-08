import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { AgentAssignment, AgentRole, ReasoningPreset } from "../domain/reasoning.js";

export interface ReasoningConfiguration {
  readonly preset: ReasoningPreset;
  readonly assignments: readonly AgentAssignment[];
}

export class ReasoningConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ReasoningConfigurationError";
  }
}

const ROLES: readonly AgentRole[] = ["investigator", "skeptic", "architect", "verifier", "judge"];

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

export function loadReasoningConfiguration(
  runtime: RuntimeConfig,
  environment: NodeJS.ProcessEnv = process.env,
): ReasoningConfiguration {
  const defaultModel = runtime.providerSelection.model;
  if (defaultModel === undefined) {
    throw new ReasoningConfigurationError("A model is required for reasoning");
  }
  return {
    preset: presetFor(runtime, environment),
    assignments: ROLES.map((role) => {
      const prefix = `CONCLAVE_${role.toUpperCase()}`;
      return {
        role,
        providerId: nonEmpty(environment[`${prefix}_PROVIDER`]) ?? runtime.providerSelection.provider,
        modelId: nonEmpty(environment[`${prefix}_MODEL`]) ?? defaultModel,
      };
    }),
  };
}
