import type { ContentSafetyAssessment } from "./security.js";

export type RepositoryKind = "local-folder";

export type SourceLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "json"
  | "markdown"
  | "css"
  | "html"
  | "yaml"
  | "shell"
  | "unknown";

export interface RepositoryDescriptor {
  readonly id: string;
  readonly kind: RepositoryKind;
  readonly name: string;
  readonly rootPath: string;
}

export interface RepositoryFile {
  readonly relativePath: string;
  readonly language: SourceLanguage;
  readonly content: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly modifiedAt: string;
  readonly safety: ContentSafetyAssessment;
}

export interface RepositoryScanStats {
  readonly filesLoaded: number;
  readonly bytesLoaded: number;
  readonly ignoredEntries: number;
  readonly skippedBinaryFiles: number;
  readonly skippedOversizedFiles: number;
  readonly skippedUnreadableFiles: number;
  readonly skippedSymlinks: number;
  readonly safetyBlockedFiles: number;
}

export interface RepositorySnapshot {
  readonly repository: RepositoryDescriptor;
  readonly files: readonly RepositoryFile[];
  readonly scannedAt: string;
  readonly stats: RepositoryScanStats;
}

export interface LoadRepositoryRequest {
  readonly path: string;
}

export interface RepositorySource {
  load(request: LoadRepositoryRequest): Promise<RepositorySnapshot>;
}

export interface EvidenceReference {
  readonly repositoryId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly excerpt?: string;
}
