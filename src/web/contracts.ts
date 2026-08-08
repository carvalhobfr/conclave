export type ProductIntent = "ask" | "investigate" | "task";
export type ProductRunStatus = "completed" | "completed-with-uncertainty" | "failed" | "blocked" | "planned" | "error";

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
  readonly task?: TaskView;
  readonly error?: { readonly code: string; readonly message: string; readonly action: string };
}

export interface RuntimeModeView {
  readonly active: "free" | "api" | "local" | "demo";
  readonly available: boolean;
  readonly provider?: string;
  readonly model?: string;
  readonly message: string;
  readonly roles: readonly { readonly role: string; readonly provider: string; readonly model: string }[];
}
