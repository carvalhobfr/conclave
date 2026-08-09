import type { IndexedCodeUnit, RepositoryCodeIndex } from "../domain/code-index.js";
import type { Evidence } from "../domain/evidence.js";
import { evidenceFromRange, evidenceFromUnit } from "./evidence-factory.js";
import { normalizeIdentifier, tokenizeCode } from "./tokenizer.js";

export interface TextSearchOptions {
  readonly caseSensitive?: boolean;
  readonly limit?: number;
}

export interface FileRange {
  readonly startLine: number;
  readonly endLine: number;
}

export interface FileTextSearchOptions {
  readonly limit?: number;
  readonly contextLines?: number;
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

  public searchFileText(query: string, options: FileTextSearchOptions = {}): readonly Evidence[] {
    const ignored = new Set(["and", "cite", "each", "file", "for", "from", "source", "summarize", "the", "this", "with"]);
    const terms = [...new Set(tokenizeCode(query).filter((term) => term.length > 2 && !ignored.has(term)))];
    if (terms.length === 0) return [];
    const files = Object.values(this.#index.files).map((file) => {
      const lines = file.sourceText.split("\n");
      const lineTokens = lines.map((line) => tokenizeCode(line));
      return { file, lines, lineTokens, tokens: new Set(lineTokens.flat()) };
    });
    const documentFrequency = new Map(terms.map((term) => [
      term,
      files.filter((entry) => entry.tokens.has(term)).length,
    ]));
    const contextLines = Math.max(1, Math.min(options.contextLines ?? 8, 40));
    const scored = files.flatMap(({ file, lines, lineTokens }) => {
      let bestStart = -1;
      let bestScore = 0;
      const pathTerms = new Set(tokenizeCode(file.path));
      const pathScore = terms.reduce((score, term) => {
        if (!pathTerms.has(term)) return score;
        const frequencyInFiles = documentFrequency.get(term) ?? 0;
        return score + Math.log(1 + (files.length + 1) / (frequencyInFiles + 1));
      }, 0);
      const scores = lines.map((line, index) => {
        if (line.length > 1_000) return 0;
        const frequencies = new Map<string, number>();
        for (const term of lineTokens[index] ?? []) {
          if (terms.includes(term)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
        }
        let score = 0;
        for (const [term, frequency] of frequencies) {
          const frequencyInFiles = documentFrequency.get(term) ?? 0;
          const idf = Math.log(1 + (files.length + 1) / (frequencyInFiles + 1));
          score += idf * (1 + Math.log(frequency));
        }
        const trimmed = line.trim();
        const declarationOnly = /^(?:export\s+)?(?:interface|type)\b/.test(trimmed) ||
          /^[A-Za-z_$][A-Za-z0-9_$]*\??:\s*(?:string|number|boolean)(?:\[\])?;$/.test(trimmed);
        const commentOnly = /^(?:\/\/|\/\*|\*|\*\/)/.test(trimmed);
        if (declarationOnly) score *= 0.2;
        else if (commentOnly) score *= 0.35;
        else if (/['"`]/.test(line)) score *= 1.35;
        return score;
      });
      for (let start = 0; start < lines.length; start += 1) {
        const score = scores.slice(start, start + contextLines).reduce((total, value) => total + value, 0) + pathScore;
        if (score > bestScore) {
          bestScore = score;
          bestStart = start;
        }
      }
      if (bestStart < 0) return [];
      const startLine = bestStart + 1;
      const endLine = Math.min(lines.length, startLine + contextLines - 1);
      return [{ file, score: bestScore, startLine, endLine }];
    });
    return scored
      .sort((left, right) => right.score - left.score || left.file.path.localeCompare(right.file.path))
      .slice(0, options.limit ?? 10)
      .map((result) => this.#remember(evidenceFromRange(
        this.#index,
        result.file.path,
        result.startLine,
        result.endLine,
        "text-match",
      )));
  }

  public readEvidence(id: string): Evidence | undefined {
    return this.#evidence.get(id);
  }

  public readUnit(id: string): Evidence | undefined {
    const unit = this.#index.units[id];
    return unit === undefined ? undefined : this.#remember(evidenceFromUnit(this.#index, unit));
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
