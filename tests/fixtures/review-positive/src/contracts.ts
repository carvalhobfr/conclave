export interface ValidationSummary {
  readonly status: "approved" | "uncertain";
  readonly findingCount: number;
}

export type ValidationMode = "deterministic" | "adaptive";
