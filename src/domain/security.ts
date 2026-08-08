export type PrivacyBoundary = "external" | "local-only";

export type ContentFindingKind =
  | "credential"
  | "private-key"
  | "prompt-injection"
  | "sensitive-file";

export type ContentFindingSeverity = "warning" | "block";

export interface ContentFinding {
  readonly kind: ContentFindingKind;
  readonly severity: ContentFindingSeverity;
  readonly line?: number;
  readonly description: string;
}

export interface ContentSafetyAssessment {
  readonly externalTransmissionAllowed: boolean;
  readonly findings: readonly ContentFinding[];
}

export interface ExternalContextPolicy {
  readonly boundary: PrivacyBoundary;
  readonly maxBytes: number;
}
