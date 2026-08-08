import type { LexicalDocument } from "../domain/code-index.js";

function splitIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token !== "");
}

function stem(token: string): string {
  if (token.length > 5 && token.endsWith("ing")) {
    return token.slice(0, -3);
  }
  if (token.length > 4 && token.endsWith("ied")) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && token.endsWith("ed")) {
    const base = token.slice(0, -2);
    return token.endsWith("red") ? `${base}e` : base;
  }
  if (token.length > 4 && token.endsWith("es")) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith("s")) {
    return token.slice(0, -1);
  }
  return token;
}

export function tokenizeCode(value: string): string[] {
  const rawTokens = value.match(/[A-Za-z][A-Za-z0-9_$-]*/g) ?? [];
  const tokens: string[] = [];
  for (const rawToken of rawTokens) {
    const normalizedWhole = rawToken.toLowerCase().replaceAll(/[_$-]/g, "");
    if (normalizedWhole !== "") {
      tokens.push(stem(normalizedWhole));
    }
    for (const part of splitIdentifier(rawToken)) {
      const normalized = part.toLowerCase();
      if (normalized !== normalizedWhole && normalized.length > 1) {
        tokens.push(stem(normalized));
      }
    }
  }
  return tokens;
}

export function normalizeIdentifier(value: string): string {
  return value.toLowerCase().replaceAll(/[^a-z0-9]/g, "");
}

export function createLexicalDocument(
  sourceText: string,
  symbol: string,
  path: string,
): LexicalDocument {
  const sourceTokens = tokenizeCode(sourceText);
  const symbolTokens = tokenizeCode(symbol);
  const pathTokens = tokenizeCode(path);
  const weightedTokens = [
    ...sourceTokens,
    ...symbolTokens,
    ...symbolTokens,
    ...symbolTokens,
    ...pathTokens,
    ...pathTokens,
  ];
  const terms: Record<string, number> = Object.create(null) as Record<string, number>;
  for (const token of weightedTokens) {
    terms[token] = (terms[token] ?? 0) + 1;
  }
  return { terms, length: weightedTokens.length };
}
