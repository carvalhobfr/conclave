export type ProductIntent = "ask" | "investigate" | "task";
export type ProductAnalysisDepth = "auto" | "fast" | "balanced" | "deep";
export type ProductRunStatus = "completed" | "completed-with-uncertainty" | "cancelled" | "timed-out" | "failed" | "blocked" | "planned" | "error";

export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  readonly source: "demo" | "local";
  readonly gitStatus: "demo" | "clean" | "unknown";
  readonly languages: readonly string[];
  readonly indexedFiles: number;
  readonly symbols: number;
  readonly graphNodes: number;
  readonly graphEdges: number;
  readonly updatedAt: string;
  readonly knowledgeStatus?: "ready";
}

export interface EvidenceView {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly excerpt: string;
  readonly origin: string;
}

export interface ClaimView {
  readonly id: string;
  readonly statement: string;
  readonly status: "supported" | "rejected" | "uncertain";
  readonly role: string;
  readonly evidenceIds: readonly string[];
  readonly challengeCount: number;
  readonly verificationCount: number;
}

export interface GraphView {
  readonly query: string;
  readonly status: "resolved" | "ambiguous" | "not-found";
  readonly nodes: readonly { readonly id: string; readonly label: string; readonly path: string }[];
  readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string; readonly relation: string; readonly provenance: string }[];
  readonly message?: string;
}

export interface TraceView {
  readonly role: string;
  readonly status: "ran" | "skipped" | "pending";
  readonly reason: string;
}

export interface RetrievalView {
  readonly operations: readonly { readonly label: string; readonly status: "executed" | "skipped" }[];
  readonly evidenceCount: number;
  readonly sourceBytes: number;
  readonly approximateTokens: number;
}

export interface TaskView {
  readonly plan: {
    readonly summary: string;
    readonly requirements: readonly string[];
    readonly steps: readonly { readonly description: string; readonly files: readonly string[] }[];
  };
  readonly permissions: {
    readonly allowFileEdits: boolean;
    readonly allowCommands: boolean;
    readonly allowRepositoryScripts: boolean;
    readonly allowNetwork: boolean;
  };
  readonly progress: readonly { readonly stage: string; readonly detail: string; readonly state: "completed" | "current" | "blocked" }[];
  readonly diff: readonly { readonly path: string; readonly additions: number; readonly deletions: number; readonly expected: boolean; readonly patch: string }[];
  readonly revisionRounds: number;
  readonly checks: readonly { readonly id: string; readonly status: string; readonly kind: string; readonly reason: string }[];
}

export type ProductChangeSetSource =
  | { readonly kind: "working-tree" }
  | { readonly kind: "staged" }
  | { readonly kind: "branch"; readonly base: string; readonly head?: string }
  | { readonly kind: "commit"; readonly base: string; readonly target: string }
  | { readonly kind: "explicit"; readonly label?: string };

export interface ProductReviewView {
  readonly status: "approved" | "changes-requested" | "uncertain" | "nothing-to-review" | "invalid";
  readonly summary: string;
  readonly source: ProductChangeSetSource;
  readonly objective?: string;
  readonly findings: readonly {
    readonly id: string;
    readonly category: string;
    readonly severity: "blocking" | "warning" | "suggestion";
    readonly statement: string;
    readonly consequence: string;
    readonly path?: string;
    readonly line?: number;
    readonly deterministic: boolean;
    readonly secretType?: string;
  }[];
  readonly confirmedProperties: readonly { readonly statement: string; readonly method: string }[];
  readonly uncertainty: readonly { readonly statement: string; readonly reason: string; readonly paths: readonly string[] }[];
  readonly changedFiles: readonly { readonly path: string; readonly changeType: string; readonly additions: number; readonly deletions: number; readonly indexed: boolean }[];
  readonly changedSymbols: readonly { readonly path: string; readonly symbol: string; readonly symbolKind: string; readonly changeType: string }[];
  readonly impactedSymbols: readonly { readonly path: string; readonly symbol: string; readonly relation: string; readonly direction: string }[];
  readonly impactTruncated: boolean;
  readonly evidence: readonly EvidenceView[];
  readonly limitations: readonly string[];
  readonly excludedSensitivePaths: readonly string[];
  readonly revisionHandoff?: string;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  readonly analysis: {
    readonly route: "project-knowledge" | "adaptive-orchestration";
    readonly requestedDepth: ProductAnalysisDepth;
    readonly selectedDepth: Exclude<ProductAnalysisDepth, "auto">;
    readonly deterministic: boolean;
    readonly reasonCodes: readonly string[];
  };
}

export interface ProductDecisionView {
  readonly status: "proceed" | "revise" | "uncertain" | "invalid";
  readonly summary: string;
  readonly objective?: string;
  readonly claims: readonly {
    readonly id: string;
    readonly statement: string;
    readonly kind: "goal" | "assumption" | "constraint" | "consequence";
    readonly status: "supported" | "rejected" | "uncertain";
    readonly explanation: string;
    readonly deterministic: boolean;
  }[];
  readonly confirmedProperties: readonly string[];
  readonly challengedAssumptions: readonly string[];
  readonly uncertainty: readonly string[];
  readonly evidence: readonly EvidenceView[];
  readonly implementationHandoff?: string;
  readonly revisionHandoff?: string;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  readonly analysis: {
    readonly requestedDepth: ProductAnalysisDepth;
    readonly selectedDepth: Exclude<ProductAnalysisDepth, "auto">;
    readonly deterministic: boolean;
    readonly reasonCodes: readonly string[];
  };
}

export interface ProductRunView {
  readonly intent: ProductIntent;
  readonly status: ProductRunStatus;
  readonly title: string;
  readonly answer: string;
  readonly claims: readonly ClaimView[];
  readonly evidence: readonly EvidenceView[];
  readonly trace: readonly TraceView[];
  readonly retrieval: RetrievalView;
  readonly metrics: readonly { readonly label: string; readonly value: string }[];
  readonly graph: GraphView;
  readonly analysis?: {
    readonly requestedDepth: ProductAnalysisDepth;
    readonly selectedDepth: Exclude<ProductAnalysisDepth, "auto">;
    readonly why: readonly string[];
    readonly deterministicAnswer: boolean;
    readonly conductorInvoked: boolean;
    readonly conductorReason: string;
    readonly earlyExitReason?: string;
    readonly timeoutMs: number;
    readonly cumulativeInputTokens: number;
    readonly cumulativeOutputTokens: number;
    readonly reviewRecommended: boolean;
    readonly reviewReasons: readonly string[];
    readonly reviewHandoff?: string;
    readonly models: readonly {
      readonly role: string;
      readonly provider: string;
      readonly model: string;
      readonly calls: number;
      readonly latencyMs: number;
      readonly requirement: string;
      readonly selectionReason: string;
    }[];
  };
  readonly suggestedNextAction?: string;
  readonly task?: TaskView;
  readonly error?: { readonly code: string; readonly message: string; readonly action: string };
}

/** Operational execution state only; model chain-of-thought is never exposed. */
export interface ProductRunProgressView {
  readonly sequence: number;
  readonly occurredAt: string;
  readonly stage: string;
  readonly detail: string;
  readonly state: "current" | "completed" | "skipped" | "failed";
}

export interface ProductRunJobView {
  readonly id: string;
  readonly intent: ProductIntent;
  readonly status: "running" | "cancelling" | "completed";
  readonly depth?: ProductAnalysisDepth;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly progress: readonly ProductRunProgressView[];
  readonly snapshot?: {
    readonly status: "working" | "sufficient" | "complete" | "cancelled" | "timed-out";
    readonly provisionalConclusion?: string;
    readonly supportedClaims: readonly ClaimView[];
    readonly rejectedClaims: readonly ClaimView[];
    readonly uncertainClaims: readonly ClaimView[];
    readonly evidence: readonly EvidenceView[];
    readonly remainingChecks: readonly string[];
  };
  readonly result?: ProductRunView;
}

export interface RuntimeModeView {
  readonly active: "free" | "api" | "local" | "demo";
  readonly available: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly source?: "environment" | "provider-set";
  readonly activeSetName?: string;
  readonly message: string;
  readonly roles: readonly { readonly role: string; readonly provider: string; readonly model: string }[];
}

export type ConfigurableProviderId =
  | "openai"
  | "openrouter"
  | "ollama"
  | "lm-studio"
  | "openai-compatible";

export type ProviderRole =
  | "investigator"
  | "skeptic"
  | "architect"
  | "verifier"
  | "judge"
  | "planner"
  | "implementer"
  | "reviewer";

export interface ProviderCatalogItemView {
  readonly id: ConfigurableProviderId;
  readonly name: string;
  readonly local: boolean;
  readonly requiresApiKey: boolean;
  readonly defaultBaseUrl?: string;
  readonly modelPlaceholder: string;
}

export interface ProviderConnectionView {
  readonly id: string;
  readonly provider: ConfigurableProviderId;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKeyConfigured: boolean;
}

export interface ProviderRoleAssignmentView {
  readonly role: ProviderRole;
  readonly connectionId: string;
  readonly model: string;
}

export interface ProviderSetView {
  readonly id: string;
  readonly name: string;
  readonly providers: readonly ProviderConnectionView[];
  readonly roles: readonly ProviderRoleAssignmentView[];
}

export interface EnvironmentProviderView {
  readonly available: boolean;
  readonly mode: "free" | "api" | "local" | "demo";
  readonly label: string;
  readonly provider?: string;
  readonly model?: string;
  readonly credentialConfigured: boolean;
  readonly locked: boolean;
  readonly roles: readonly { readonly role: string; readonly provider: string; readonly model: string }[];
  readonly message: string;
}

export interface ProviderSettingsView {
  readonly maximumSets: 5;
  readonly activeSetId?: string;
  readonly environment: EnvironmentProviderView;
  readonly catalog: readonly ProviderCatalogItemView[];
  readonly sets: readonly ProviderSetView[];
}

export interface ProviderModelView {
  readonly id: string;
  readonly name: string;
  readonly contextLength?: number;
}

export type ProviderProfileId = "economy" | "balanced" | "quality";

export interface ProviderModelProfileView {
  readonly id: ProviderProfileId;
  readonly name: string;
  readonly description: string;
  readonly defaultModel: string;
  readonly assignments: readonly ProviderRoleAssignmentView[];
}

export interface ProviderModelsView {
  readonly provider: "openai" | "openrouter";
  readonly models: readonly ProviderModelView[];
  readonly profiles: readonly ProviderModelProfileView[];
}

export interface ProviderModelsInput {
  readonly provider: ConfigurableProviderId;
  /** A transient personal key. The local server uses it for this lookup and never returns it. */
  readonly apiKey?: string;
  /** Allows a saved personal key to be reused without returning it to the browser. */
  readonly setId?: string;
  readonly connectionId?: string;
}

export interface ProviderConnectionInput {
  readonly id: string;
  readonly provider: ConfigurableProviderId;
  readonly model: string;
  readonly baseUrl?: string;
  /** Omit or leave blank to retain an already configured key. */
  readonly apiKey?: string;
}

export interface ProviderSetInput {
  readonly id: string;
  readonly name: string;
  readonly providers: readonly ProviderConnectionInput[];
  readonly roles: readonly ProviderRoleAssignmentView[];
}

export interface SaveProviderSettingsInput {
  readonly activeSetId?: string;
  readonly sets: readonly ProviderSetInput[];
}

export interface ImportedRepositoryFile {
  readonly path: string;
  readonly content: string;
}
