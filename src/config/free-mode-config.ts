import type { AgentRole } from "../domain/reasoning.js";
import type { TaskAgentRole } from "../domain/task-execution.js";

export const DEFAULT_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const DEFAULT_FREE_MODEL = "deepseek-v4-flash-free";

export const DEFAULT_FREE_REASONING_MODELS: Readonly<Record<AgentRole, string>> = {
  conductor: "deepseek-v4-flash-free",
  investigator: "deepseek-v4-flash-free",
  skeptic: "nemotron-3-ultra-free",
  architect: "nemotron-3-ultra-free",
  verifier: "deepseek-v4-flash-free",
  judge: "nemotron-3-ultra-free",
};

export const DEFAULT_FREE_TASK_MODELS: Readonly<Record<TaskAgentRole, string>> = {
  planner: "nemotron-3-ultra-free",
  implementer: "north-mini-code-free",
  reviewer: "deepseek-v4-flash-free",
};

export const DEFAULT_FREE_MODEL_ALLOWLIST: readonly string[] = [
  "deepseek-v4-flash-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
];

const SAFE_MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export function parseFreeModelAllowlist(value: string | undefined): readonly string[] {
  const models = value === undefined || value.trim() === ""
    ? DEFAULT_FREE_MODEL_ALLOWLIST
    : value.split(",").map((model) => model.trim()).filter((model) => model !== "");
  const unique = [...new Set(models)];
  if (unique.length === 0 || unique.some((model) => !SAFE_MODEL_ID.test(model))) {
    throw new Error("CONCLAVE_FREE_MODEL_ALLOWLIST must contain valid comma-separated provider model IDs");
  }
  return unique;
}

export function assertFreeModelAllowed(model: string, allowedModels: readonly string[]): void {
  if (!allowedModels.includes(model)) {
    throw new Error(`Free Mode model ${model} is not in the host-controlled allowlist`);
  }
}
