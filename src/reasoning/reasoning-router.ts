import type { ContextBundle } from "../domain/context-bundle.js";
import type {
  AgentRole,
  AgentSelection,
  Claim,
  ReasoningPreset,
} from "../domain/reasoning.js";

function complexQuestion(question: string): boolean {
  return /\b(why|how|might|cause|causal|lifecycle|initiali[sz]|refresh|race|cleanup|state flow|disappear)\b/i.test(
    question,
  );
}

function crossModuleContext(context: ContextBundle): boolean {
  if (context.stats.filesRepresented < 2) return false;
  const sourceUnits = new Map(
    context.evidence.flatMap((unit) => unit.sourceUnitIds.map((id) => [id, unit.path] as const)),
  );
  return context.relationships.some((edge) => {
    if (edge.from.kind !== "symbol" || edge.to.kind !== "symbol") return false;
    const from = sourceUnits.get(edge.from.id);
    const to = sourceUnits.get(edge.to.id);
    return from !== undefined && to !== undefined && from !== to;
  });
}

export function routeReasoningAgents(
  preset: ReasoningPreset,
  question: string,
  context: ContextBundle,
  claims: readonly Claim[],
): readonly AgentSelection[] {
  const complex = complexQuestion(question);
  const crossModule = crossModuleContext(context) || context.stats.filesRepresented >= 3;
  const uncertain = claims.some(
    (claim) => claim.uncertainty !== "none" || claim.evidenceIds.length === 0,
  );
  const skepticSelected = complex || uncertain;
  const architectSelected = preset !== "free-like" && complex && crossModule;
  const selections: Readonly<Record<AgentRole, AgentSelection>> = {
    investigator: { role: "investigator", selected: true, reason: "claims require an initial investigator" },
    skeptic: {
      role: "skeptic",
      selected: skepticSelected,
      reason: skepticSelected
        ? complex
          ? "causal or lifecycle question benefits from adversarial review"
          : "investigator returned uncertain or unsupported claims"
        : "exact low-uncertainty question does not justify adversarial review",
    },
    architect: {
      role: "architect",
      selected: architectSelected,
      reason:
        preset === "free-like"
          ? "free-like preset avoids architect calls"
          : architectSelected
            ? "cross-module causal context benefits from architecture review"
            : "question is not both causal and cross-module",
    },
    verifier: { role: "verifier", selected: true, reason: "material claims require verification" },
    judge: { role: "judge", selected: true, reason: "verified claims require adjudication" },
  };
  return [
    selections.investigator,
    selections.skeptic,
    selections.architect,
    selections.verifier,
    selections.judge,
  ];
}
