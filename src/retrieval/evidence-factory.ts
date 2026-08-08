import { createHash } from "node:crypto";

import type { IndexedCodeUnit, RepositoryCodeIndex } from "../domain/code-index.js";
import type { Evidence, EvidenceOrigin } from "../domain/evidence.js";

function lines(sourceText: string): readonly string[] {
  return sourceText.split("\n");
}

function excerptForRange(sourceText: string, startLine: number, endLine: number): string {
  return lines(sourceText).slice(startLine - 1, endLine).join("\n");
}

function evidenceId(
  repositoryId: string,
  path: string,
  startLine: number,
  endLine: number,
  sourceIdentity: string,
): string {
  return `evidence_${createHash("sha256")
    .update(`${repositoryId}\0${path}\0${String(startLine)}\0${String(endLine)}\0${sourceIdentity}`)
    .digest("hex")
    .slice(0, 24)}`;
}

export function evidenceFromUnit(index: RepositoryCodeIndex, unit: IndexedCodeUnit): Evidence {
  const file = index.files[unit.path];
  if (file === undefined) {
    throw new Error(`Structural unit ${unit.id} references a missing file`);
  }
  return {
    id: evidenceId(index.repository.id, unit.path, unit.startLine, unit.endLine, unit.sourceIdentity),
    repositoryId: index.repository.id,
    path: unit.path,
    startLine: unit.startLine,
    endLine: unit.endLine,
    symbol: unit.symbol,
    symbolKind: unit.symbolKind,
    excerpt: excerptForRange(file.sourceText, unit.startLine, unit.endLine),
    provenance: {
      origin: "structural-unit",
      repositoryId: index.repository.id,
      sourceIdentity: unit.sourceIdentity,
      contentHash: file.contentHash,
      unitId: unit.id,
    },
  };
}

export function evidenceFromRange(
  index: RepositoryCodeIndex,
  path: string,
  startLine: number,
  endLine: number,
  origin: Exclude<EvidenceOrigin, "structural-unit">,
): Evidence {
  const file = index.files[path];
  if (file === undefined) {
    throw new Error(`File is not indexed: ${path}`);
  }
  const fileLines = lines(file.sourceText);
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > fileLines.length
  ) {
    throw new Error(`Invalid source range ${String(startLine)}-${String(endLine)} for ${path}`);
  }
  const sourceIdentity = createHash("sha256")
    .update(`${file.contentHash}\0${String(startLine)}\0${String(endLine)}\0${origin}`)
    .digest("hex");
  return {
    id: evidenceId(index.repository.id, path, startLine, endLine, sourceIdentity),
    repositoryId: index.repository.id,
    path,
    startLine,
    endLine,
    excerpt: excerptForRange(file.sourceText, startLine, endLine),
    provenance: {
      origin,
      repositoryId: index.repository.id,
      sourceIdentity,
      contentHash: file.contentHash,
    },
  };
}
