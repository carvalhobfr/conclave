import type { IndexedCodeUnit, RepositoryCodeIndex } from "../domain/code-index.js";
import { tokenizeCode } from "./tokenizer.js";

export interface Bm25Config {
  readonly k1: number;
  readonly b: number;
}

export interface ScoredUnit {
  readonly unit: IndexedCodeUnit;
  readonly score: number;
}

export const DEFAULT_BM25_CONFIG: Bm25Config = { k1: 1.2, b: 0.75 };

export function searchBm25(
  index: RepositoryCodeIndex,
  query: string,
  config: Bm25Config = DEFAULT_BM25_CONFIG,
): readonly ScoredUnit[] {
  const units = Object.values(index.units);
  const queryTerms = tokenizeCode(query);
  if (units.length === 0 || queryTerms.length === 0) {
    return [];
  }
  const queryFrequency = new Map<string, number>();
  for (const term of queryTerms) {
    queryFrequency.set(term, (queryFrequency.get(term) ?? 0) + 1);
  }
  const averageLength =
    units.reduce((sum, unit) => sum + unit.lexical.length, 0) / Math.max(units.length, 1);
  const documentFrequency = new Map<string, number>();
  for (const term of queryFrequency.keys()) {
    documentFrequency.set(
      term,
      units.filter((unit) => (unit.lexical.terms[term] ?? 0) > 0).length,
    );
  }

  const scored = units.flatMap((unit) => {
    let score = 0;
    for (const [term, queryCount] of queryFrequency) {
      const frequency = unit.lexical.terms[term] ?? 0;
      if (frequency === 0) {
        continue;
      }
      const matchingDocuments = documentFrequency.get(term) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (units.length - matchingDocuments + 0.5) / (matchingDocuments + 0.5),
      );
      const lengthNormalization =
        1 - config.b + config.b * (unit.lexical.length / Math.max(averageLength, 1));
      score +=
        queryCount *
        inverseDocumentFrequency *
        ((frequency * (config.k1 + 1)) / (frequency + config.k1 * lengthNormalization));
    }
    return score > 0 ? [{ unit, score }] : [];
  });
  return scored.sort(
    (left, right) =>
      right.score - left.score ||
      left.unit.path.localeCompare(right.unit.path) ||
      left.unit.startLine - right.unit.startLine ||
      left.unit.id.localeCompare(right.unit.id),
  );
}
