import type {
  AnalysisDepth,
  ModelRequirement,
  QueryAssessment,
  ReasoningPlan,
  SelectedAnalysisDepth,
} from "../domain/adaptive-reasoning.js";
import type { AgentRole, ReasoningLimits } from "../domain/reasoning.js";

const PLANNABLE_ROLES = new Set<AgentRole>(["investigator", "skeptic", "architect", "verifier", "judge"]);
const DEPTHS = new Set<SelectedAnalysisDepth>(["fast", "balanced", "deep"]);
const STRATEGIES = new Set<ReasoningPlan["strategy"]>(["deterministic", "graph-first", "retrieval-first", "causal-investigation", "task-investigation"]);

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length > 0) throw new Error(`${label} contains forbidden fields: ${unexpected.join(", ")}`);
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) throw new Error(`${label} must be a string array`);
  return (value as unknown[]).slice(0, 20).map((item) => item as string);
}

function requirement(value: unknown): ModelRequirement {
  const item = record(value, "model requirement");
  only(item, ["reasoning", "coding", "speed", "context", "independencePreferred", "costPreference"], "model requirement");
  const result: ModelRequirement = {};
  const reasoning = item["reasoning"];
  if (reasoning !== undefined) {
    if (typeof reasoning !== "string" || !new Set(["low", "medium", "high"]).has(reasoning)) throw new Error("invalid reasoning requirement");
    Object.assign(result, { reasoning });
  }
  const coding = item["coding"];
  if (coding !== undefined) {
    if (typeof coding !== "string" || !new Set(["low", "medium", "high"]).has(coding)) throw new Error("invalid coding requirement");
    Object.assign(result, { coding });
  }
  const speed = item["speed"];
  if (speed !== undefined) {
    if (typeof speed !== "string" || !new Set(["interactive", "normal", "slow-ok"]).has(speed)) throw new Error("invalid speed requirement");
    Object.assign(result, { speed });
  }
  const context = item["context"];
  if (context !== undefined) {
    if (typeof context !== "string" || !new Set(["small", "medium", "large"]).has(context)) throw new Error("invalid context requirement");
    Object.assign(result, { context });
  }
  if (item["independencePreferred"] !== undefined) {
    if (typeof item["independencePreferred"] !== "boolean") throw new Error("invalid independence preference");
    Object.assign(result, { independencePreferred: item["independencePreferred"] });
  }
  const costPreference = item["costPreference"];
  if (costPreference !== undefined) {
    if (typeof costPreference !== "string" || !new Set(["free-only", "prefer-free", "any-configured"]).has(costPreference)) throw new Error("invalid cost preference");
    Object.assign(result, { costPreference });
  }
  return result;
}

export function conductorPrompt(
  question: string,
  assessment: QueryAssessment,
  requestedDepth: AnalysisDepth,
  budget: ReasoningLimits,
  providersAvailable: boolean,
): string {
  return [
    "BEGIN TRUSTED ROUTING ASSESSMENT",
    JSON.stringify({ question, assessment, requestedDepth, budgets: { maxAgentCalls: budget.maxAgentCalls, maxRounds: budget.maxRounds, maxApproximateInputTokens: budget.maxApproximateInputTokens }, providersAvailable }),
    "END TRUSTED ROUTING ASSESSMENT",
    "Plan reasoning only. The host enforces budgets, permissions, provider endpoints, repository roots, credentials, retrieval, and verification policy.",
  ].join("\n");
}

export function parseConductorOutput(
  raw: string,
  requestedDepth: AnalysisDepth,
  budget: ReasoningLimits,
): ReasoningPlan {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("Conductor output is not valid JSON"); }
  const value = record(parsed, "Conductor output");
  only(value, ["depth", "strategy", "roles", "modelRequirements", "finalReview", "reasonCodes"], "Conductor output");
  if (!DEPTHS.has(value["depth"] as SelectedAnalysisDepth)) throw new Error("Conductor depth is invalid");
  const depth = value["depth"] as SelectedAnalysisDepth;
  if (requestedDepth !== "auto" && depth !== requestedDepth) throw new Error("Conductor cannot override a forced analysis depth");
  if (!STRATEGIES.has(value["strategy"] as ReasoningPlan["strategy"])) throw new Error("Conductor strategy is invalid");
  if (!Array.isArray(value["roles"])) throw new Error("Conductor roles must be an array");
  if (value["roles"].length > budget.maxAgentCalls) throw new Error("Conductor plan exceeds the model-call budget");
  const roles = value["roles"].map((rawRole) => {
    const role = record(rawRole, "planned role");
    only(role, ["role", "requirement"], "planned role");
    if (!PLANNABLE_ROLES.has(role["role"] as AgentRole)) throw new Error(`Conductor requested forbidden role: ${String(role["role"])}`);
    if (role["requirement"] !== "required" && role["requirement"] !== "conditional") throw new Error("planned role requirement is invalid");
    return { role: role["role"] as AgentRole, requirement: role["requirement"] } as const;
  });
  if (new Set(roles.map((item) => item.role)).size !== roles.length) throw new Error("Conductor roles must be unique");
  const rawRequirements = record(value["modelRequirements"] ?? {}, "modelRequirements");
  const modelRequirements: Partial<Record<AgentRole, ModelRequirement>> = {};
  for (const [role, rawRequirement] of Object.entries(rawRequirements)) {
    if (!PLANNABLE_ROLES.has(role as AgentRole)) throw new Error(`Conductor supplied requirement for forbidden role: ${role}`);
    modelRequirements[role as AgentRole] = requirement(rawRequirement);
  }
  if (!new Set(["none", "conditional", "recommended"]).has(String(value["finalReview"]))) throw new Error("Conductor finalReview is invalid");
  return {
    depth,
    strategy: value["strategy"] as ReasoningPlan["strategy"],
    roles,
    modelRequirements,
    finalReview: value["finalReview"] as ReasoningPlan["finalReview"],
    reasonCodes: stringArray(value["reasonCodes"], "reasonCodes"),
  };
}

export function shouldInvokeConductor(assessment: QueryAssessment, depth: SelectedAnalysisDepth): boolean {
  if (!assessment.requiresModelReasoning || assessment.deterministicCoverage === "strong") return false;
  return assessment.ambiguity === "high" && (assessment.queryKind === "ambiguous" || assessment.queryKind === "causal" || depth === "deep");
}
