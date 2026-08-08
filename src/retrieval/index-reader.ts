import type { IndexedCodeUnit, RepositoryCodeIndex } from "../domain/code-index.js";
import type { Evidence } from "../domain/evidence.js";
import { evidenceFromRange, evidenceFromUnit } from "./evidence-factory.js";
import { normalizeIdentifier } from "./tokenizer.js";

export interface TextSearchOptions {
  readonly caseSensitive?: boolean;
  readonly limit?: number;
}

export interface FileRange {
  readonly startLine: number;
  readonly endLine: number;
}

function lineAtOffset(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (content.charCodeAt(index) === 10) {
      line += 1;
    }
  }
  return line;
}

export class CodeIndexReader {
  readonly #index: RepositoryCodeIndex;
  readonly #evidence = new Map<string, Evidence>();

  public constructor(index: RepositoryCodeIndex) {
    this.#index = index;
    for (const unit of Object.values(index.units)) {
      const evidence = evidenceFromUnit(index, unit);
      this.#evidence.set(evidence.id, evidence);
    }
  }

  public get index(): RepositoryCodeIndex {
    return this.#index;
  }

  public findSymbol(name: string, path?: string): readonly Evidence[] {
    const normalized = normalizeIdentifier(name);
    return Object.values(this.#index.units)
      .filter(
        (unit) =>
          (path === undefined || unit.path === path) &&
          (unit.symbol === name || normalizeIdentifier(unit.symbol) === normalized),
      )
      .sort((left, right) => {
        const leftExact = left.symbol === name ? 0 : 1;
        const rightExact = right.symbol === name ? 0 : 1;
        return leftExact - rightExact || left.path.localeCompare(right.path) || left.startLine - right.startLine;
      })
      .map((unit) => this.#remember(evidenceFromUnit(this.#index, unit)));
  }

  public findSymbolsInFile(path: string): readonly Evidence[] {
    const file = this.#index.files[path];
    if (file === undefined) {
      return [];
    }
    return file.symbolIds
      .map((id) => this.#index.units[id])
      .filter((unit): unit is IndexedCodeUnit => unit !== undefined)
      .map((unit) => this.#remember(evidenceFromUnit(this.#index, unit)));
  }

  public findExportedSymbols(): readonly Evidence[] {
    return Object.values(this.#index.units)
      .filter((unit) => unit.exported)
      .sort((left, right) => left.path.localeCompare(right.path) || left.startLine - right.startLine)
      .map((unit) => this.#remember(evidenceFromUnit(this.#index, unit)));
  }

  public searchText(text: string, options: TextSearchOptions = {}): readonly Evidence[] {
    if (text === "") {
      return [];
    }
    const caseSensitive = options.caseSensitive ?? true;
    const needle = caseSensitive ? text : text.toLowerCase();
    const limit = options.limit ?? 100;
    const results: Evidence[] = [];
    const seen = new Set<string>();

    for (const file of Object.values(this.#index.files).sort((left, right) => left.path.localeCompare(right.path))) {
      const haystack = caseSensitive ? file.sourceText : file.sourceText.toLowerCase();
      let offset = haystack.indexOf(needle);
      while (offset >= 0 && results.length < limit) {
        const startLine = lineAtOffset(file.sourceText, offset);
        const endLine = lineAtOffset(file.sourceText, offset + Math.max(needle.length - 1, 0));
        const evidence = evidenceFromRange(this.#index, file.path, startLine, endLine, "text-match");
        if (!seen.has(evidence.id)) {
          seen.add(evidence.id);
          results.push(this.#remember(evidence));
        }
        offset = haystack.indexOf(needle, offset + Math.max(needle.length, 1));
      }
      if (results.length >= limit) {
        break;
      }
    }
    return results;
  }

  public readEvidence(id: string): Evidence | undefined {
    return this.#evidence.get(id);
  }

  public readFile(path: string, range?: FileRange): Evidence {
    const file = this.#index.files[path];
    if (file === undefined) {
      throw new Error(`File is not indexed: ${path}`);
    }
    const lineCount = file.sourceText.split("\n").length;
    const evidence = evidenceFromRange(
      this.#index,
      path,
      range?.startLine ?? 1,
      range?.endLine ?? lineCount,
      "file-range",
    );
    return this.#remember(evidence);
  }

  #remember(evidence: Evidence): Evidence {
    this.#evidence.set(evidence.id, evidence);
    return evidence;
  }
}
