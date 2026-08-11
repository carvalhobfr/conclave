import type { GraphRelation } from "./code-index.js";

export type ChangeSource =
  | { readonly kind: "working" }
  | { readonly kind: "staged" }
  | { readonly kind: "branch"; readonly base: string }
  | { readonly kind: "commit"; readonly commit: string };

export type ChangedFileStatus = "added" | "modified" | "deleted" | "renamed" | "copied" | "unknown";

export interface ChangedLineRange {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export interface ChangedFile {
  readonly path: string;
  readonly previousPath?: string;
  readonly status: ChangedFileStatus;
  readonly hunks: readonly ChangedLineRange[];
}

export interface ChangeSet {
  readonly source: ChangeSource;
  readonly headSha: string;
  readonly files: readonly ChangedFile[];
  readonly patch: string;
  readonly collectedAt: string;
}

export type ValidationClaimCheck =
  | {
      readonly kind: "symbol-exists";
      readonly symbol: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "callers";
      readonly symbol: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "references";
      readonly symbol: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "text";
      readonly text: string;
      readonly expectation: "present" | "absent";
    }
  | {
      readonly kind: "file-changed";
      readonly path: string;
      readonly expectation: "present" | "absent";
    };

export interface ValidationClaim {
  readonly id: string;
  readonly statement: string;
  readonly check: ValidationClaimCheck;
}

export interface ValidationContract {
  readonly objective: string;
  readonly claims: readonly ValidationClaim[];
  readonly allowedPathPrefixes: readonly string[];
}

export type ValidationVerdict = "pass" | "warn" | "block" | "inconclusive";
export type ValidationFindingSeverity = "info" | "warning" | "blocking";

export type ValidationFindingKind =
  | "no-change"
  | "missing-objective"
  | "scope-expansion"
  | "parser-diagnostic"
  | "impact-outside-diff"
  | "exported-change-without-tests"
  | "head-only-deletion"
  | "claim-contradicted"
  | "claim-inconclusive";

export interface ValidationEvidence {
  readonly path: string;
  readonly startLine?: number;
  readonly endLine?: number;
  readonly symbol?: string;
  readonly relation?: GraphRelation;
  readonly reason: string;
}

export interface ValidationFinding {
  readonly id: string;
  readonly kind: ValidationFindingKind;
  readonly severity: ValidationFindingSeverity;
  readonly title: string;
  readonly detail: string;
  readonly evidence: readonly ValidationEvidence[];
  readonly remediation: string;
}

export type ValidationClaimOutcome = "supported" | "rejected" | "inconclusive";

export interface ValidationClaimResult {
  readonly claim: ValidationClaim;
  readonly outcome: ValidationClaimOutcome;
  readonly explanation: string;
  readonly evidence: readonly ValidationEvidence[];
}

export interface ValidationMetrics {
  readonly filesChanged: number;
  readonly symbolsChanged: number;
  readonly impactedFiles: number;
  readonly impactedSymbols: number;
  readonly graphEdgesInspected: number;
  readonly deterministicChecks: number;
  readonly durationMs: number;
}

export interface ValidationReport {
  readonly schemaVersion: 1;
  readonly verdict: ValidationVerdict;
  readonly summary: string;
  readonly objective: string;
  readonly changeSet: Omit<ChangeSet, "patch"> & { readonly patchBytes: number };
  readonly findings: readonly ValidationFinding[];
  readonly claims: readonly ValidationClaimResult[];
  readonly impact: {
    readonly changedSymbols: readonly string[];
    readonly impactedFiles: readonly string[];
    readonly impactedSymbols: readonly string[];
  };
  readonly metrics: ValidationMetrics;
}
