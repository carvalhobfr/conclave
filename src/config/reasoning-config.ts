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

/**
 * Local Mode is a privacy boundary, so a role pointing at a hosted provider would send
 * repository excerpts off the machine. Refusing is correct; failing here rather than deep in
 * the pipeline lets the message name the variables that have to change.
 */
function assertLocalRoleProviders(runtime: RuntimeConfig, environment: NodeJS.ProcessEnv): void {
  if (runtime.mode !== "local") return;
  const local = runtime.providerSelection.provider;
  const foreign = ROLES
    .map((role) => ({ role, provider: nonEmpty(environment[`CONCLAVE_${role.toUpperCase()}_PROVIDER`]) }))
    .filter((entry): entry is { role: AgentRole; provider: string } =>
      entry.provider !== undefined && entry.provider !== local);
  if (foreign.length === 0) return;
  const variables = foreign
    .map((entry) => `CONCLAVE_${entry.role.toUpperCase()}_PROVIDER=${entry.provider}`)
    .join(", ");
  const models = foreign
    .map((entry) => `CONCLAVE_${entry.role.toUpperCase()}_MODEL`)
    .join(", ");
  throw new ReasoningConfigurationError(
    `Local Mode keeps every reasoning role on ${local}, but ${variables} name another provider. ` +
    `Set those to ${local} and point ${models} at a model served by ${local}, ` +
    "or leave the role variables unset so every role follows CONCLAVE_PROVIDER. " +
    "Removing them from the shell is not enough when a .env file also defines them.",
  );
}

export function loadReasoningConfiguration(
  runtime: RuntimeConfig,
  environment: NodeJS.ProcessEnv = process.env,
): ReasoningConfiguration {
  const defaultModel = runtime.providerSelection.model;
  if (defaultModel === undefined) {
    throw new ReasoningConfigurationError("A model is required for reasoning");
  }
  assertLocalRoleProviders(runtime, environment);
  return {
    preset: presetFor(runtime, environment),
    assignments: ROLES.map((role) => {
      const prefix = `CONCLAVE_${role.toUpperCase()}`;
      const modelId = nonEmpty(environment[`${prefix}_MODEL`]) ?? defaultModel;
      const fallbackModelId = nonEmpty(environment[`${prefix}_FALLBACK_MODEL`])
        ?? nonEmpty(environment["CONCLAVE_FALLBACK_MODEL"]);
      return {
        role,
        providerId: nonEmpty(environment[`${prefix}_PROVIDER`]) ?? runtime.providerSelection.provider,
        modelId,
        ...(fallbackModelId === undefined || fallbackModelId === modelId ? {} : { fallbackModelId }),
      };
    }),
  };
}
