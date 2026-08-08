import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { TaskAgentAssignment, TaskAgentRole } from "../domain/task-execution.js";

export interface TaskConfiguration {
  readonly assignments: readonly TaskAgentAssignment[];
  readonly allowedPackageScripts: readonly string[];
}

export class TaskConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "TaskConfigurationError";
  }
}

const ROLES: readonly TaskAgentRole[] = ["planner", "implementer", "reviewer"];

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function packageScripts(value: string | undefined): readonly string[] {
  if (value === undefined || value.trim() === "") return [];
  const names = value
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  for (const name of names) {
    if (!/^[a-zA-Z0-9:_-]{1,80}$/.test(name)) {
      throw new TaskConfigurationError(`Invalid allowed package script: ${name}`);
    }
  }
  return [...new Set(names)];
}

export function loadTaskConfiguration(
  runtime: RuntimeConfig,
  environment: NodeJS.ProcessEnv = process.env,
): TaskConfiguration {
  const defaultModel = runtime.providerSelection.model;
  if (defaultModel === undefined) {
    throw new TaskConfigurationError("A model is required for Task Mode");
  }
  return {
    assignments: ROLES.map((role) => {
      const prefix = `CONCLAVE_${role.toUpperCase()}`;
      return {
        role,
        providerId: nonEmpty(environment[`${prefix}_PROVIDER`]) ?? runtime.providerSelection.provider,
        modelId: nonEmpty(environment[`${prefix}_MODEL`]) ?? defaultModel,
      };
    }),
    allowedPackageScripts: packageScripts(environment["CONCLAVE_ALLOWED_PACKAGE_SCRIPTS"]),
  };
}
