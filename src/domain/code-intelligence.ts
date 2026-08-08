import type { RepositoryFile, SourceLanguage } from "./repository.js";

export type CodeSymbolKind =
  | "function"
  | "class"
  | "method"
  | "react-component"
  | "hook"
  | "interface"
  | "type-alias"
  | "enum"
  | "variable-function";

export type ImportBindingKind = "default" | "named" | "namespace" | "require";

export interface ImportBinding {
  readonly imported: string;
  readonly local: string;
  readonly kind: ImportBindingKind;
  readonly typeOnly: boolean;
}

export interface ImportReference {
  readonly source: string;
  readonly line: number;
  readonly bindings: readonly ImportBinding[];
}

export type ExportKind = "named" | "default" | "re-export" | "commonjs";

export interface ExportReference {
  readonly name: string;
  readonly localName?: string;
  readonly source?: string;
  readonly line: number;
  readonly kind: ExportKind;
}

export interface CallReference {
  readonly name: string;
  readonly line: number;
}

export type HeritageRelation = "extends" | "implements";

export interface HeritageReference {
  readonly name: string;
  readonly relation: HeritageRelation;
  readonly line: number;
}

export interface ParseDiagnostic {
  readonly message: string;
  readonly line: number;
  readonly column: number;
}

export interface StructuralCodeUnit {
  readonly id: string;
  readonly sourceIdentity: string;
  readonly path: string;
  readonly language: SourceLanguage;
  readonly symbol: string;
  readonly symbolKind: CodeSymbolKind;
  readonly startLine: number;
  readonly endLine: number;
  readonly sourceText: string;
  readonly parentSymbol?: string;
  readonly imports: readonly ImportReference[];
  readonly exports: readonly ExportReference[];
  readonly references: readonly string[];
  readonly calls: readonly CallReference[];
  readonly heritage: readonly HeritageReference[];
  readonly exported: boolean;
  readonly async: boolean;
}

export interface FileIntelligence {
  readonly path: string;
  readonly language: SourceLanguage;
  readonly contentHash: string;
  readonly sourceText: string;
  readonly imports: readonly ImportReference[];
  readonly exports: readonly ExportReference[];
  readonly units: readonly StructuralCodeUnit[];
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly parserId: string;
}

export interface CodeParser {
  readonly id: string;
  supports(language: SourceLanguage): boolean;
  parse(file: RepositoryFile): FileIntelligence;
}
