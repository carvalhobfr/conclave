import type { RepositoryCodeIndex } from "../domain/code-index.js";
import type { ValidationChangedFile, ValidationEvidence } from "../domain/validation.js";

/**
 * Defect classes that are visible in the changed text itself, so they need no model call.
 * Each one is a pattern a reviewer applies by eye; running it here makes the result
 * reproducible, free, and available offline.
 */
export interface SourceDefect {
  readonly kind: "unreleased-resource" | "discarded-error" | "inconsistent-key";
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
  readonly evidence: ValidationEvidence;
}

/** Acquire/release pairs whose release is a distinct, greppable identifier. */
const RESOURCE_PAIRS: readonly { readonly acquire: string; readonly release: string }[] = [
  { acquire: "addEventListener", release: "removeEventListener" },
  { acquire: "setInterval", release: "clearInterval" },
  { acquire: "subscribe", release: "unsubscribe" },
  { acquire: "createReadStream", release: "close" },
  { acquire: "watch", release: "unwatch" },
];

/** Keyed accessors whose calls in one file are expected to address the same store. */
const KEYED_ACCESSORS = /\.(?:setItem|getItem|removeItem)\s*\(\s*([^,)]+?)\s*[,)]/gu;

const JS_FAMILY = /\.(?:[cm]?[jt]sx?)$/iu;

function changedLineNumbers(file: ValidationChangedFile, totalLines: number): readonly number[] {
  if (file.hunks.length === 0) {
    return file.status === "added" ? Array.from({ length: totalLines }, (_, index) => index + 1) : [];
  }
  const lines = new Set<number>();
  for (const hunk of file.hunks) {
    const count = Math.max(0, hunk.newCount);
    for (let offset = 0; offset < count; offset += 1) lines.add(hunk.newStart + offset);
  }
  return [...lines].sort((left, right) => left - right);
}

/** Strips string and comment bodies so a pattern never matches inside prose. */
function withoutLiterals(line: string): string {
  return line
    .replace(/\/\/.*$/u, "")
    .replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/gu, '""');
}

function evidenceFor(path: string, line: number, reason: string): ValidationEvidence {
  return { path, startLine: line, endLine: line, reason };
}

function unreleasedResources(
  index: RepositoryCodeIndex,
  file: ValidationChangedFile,
  lines: readonly string[],
  changed: readonly number[],
): readonly SourceDefect[] {
  // A release call anywhere in the project counts: cleanup often lives in another module.
  const projectText = Object.values(index.files).map((entry) => entry.sourceText).join("\n");
  const defects: SourceDefect[] = [];
  for (const line of changed) {
    const text = withoutLiterals(lines[line - 1] ?? "");
    for (const pair of RESOURCE_PAIRS) {
      if (!new RegExp(`\\b${pair.acquire}\\s*\\(`, "u").test(text)) continue;
      if (new RegExp(`\\b${pair.release}\\s*\\(`, "u").test(projectText)) continue;
      defects.push({
        kind: "unreleased-resource",
        title: "Changed code acquires a resource the project never releases",
        detail: `${pair.acquire} is called on a changed line, but ${pair.release} appears nowhere in the indexed project, so the resource is never released.`,
        remediation: `Call ${pair.release} on the matching teardown path, or record why this registration is intentionally permanent.`,
        evidence: evidenceFor(file.path, line, `${pair.acquire} without a matching ${pair.release}`),
      });
    }
  }
  return defects;
}

function discardedErrors(
  file: ValidationChangedFile,
  lines: readonly string[],
  changed: readonly number[],
): readonly SourceDefect[] {
  const defects: SourceDefect[] = [];
  const changedSet = new Set(changed);
  for (const line of changed) {
    const text = withoutLiterals(lines[line - 1] ?? "");
    const match = /\bcatch\s*(?:\([^)]*\))?\s*\{(.*)$/u.exec(text);
    if (match === null) continue;
    // The body is empty when the brace closes with nothing but whitespace between, either on
    // this line or across the following lines up to the closing brace.
    let body = match[1] ?? "";
    let cursor = line;
    while (!body.includes("}") && cursor < lines.length) {
      cursor += 1;
      body += `\n${withoutLiterals(lines[cursor - 1] ?? "")}`;
    }
    const inner = body.slice(0, body.indexOf("}"));
    if (inner.trim() !== "") continue;
    if (!changedSet.has(line)) continue;
    defects.push({
      kind: "discarded-error",
      title: "Changed code discards a caught error",
      detail: "A catch block introduced or modified by this change has an empty body, so the failure it catches leaves no trace.",
      remediation: "Handle, rethrow, or record the error, or state in the code why discarding it is correct.",
      evidence: evidenceFor(file.path, line, "catch block with an empty body"),
    });
  }
  return defects;
}

function inconsistentKeys(
  file: ValidationChangedFile,
  source: string,
  lines: readonly string[],
  changed: readonly number[],
): readonly SourceDefect[] {
  const constants: { readonly line: number; readonly key: string }[] = [];
  const literals: { readonly line: number; readonly key: string }[] = [];
  lines.forEach((raw, index) => {
    const text = withoutLiterals(raw) === raw ? raw : raw;
    for (const match of text.matchAll(KEYED_ACCESSORS)) {
      const key = match[1]?.trim();
      if (key === undefined || key === "") continue;
      const entry = { line: index + 1, key };
      if (/^["'`]/u.test(key)) literals.push(entry);
      else if (/^[A-Za-z_$][\w$]*$/u.test(key)) constants.push(entry);
    }
  });
  if (constants.length === 0 || literals.length === 0) return [];
  const changedSet = new Set(changed);
  const named = [...new Set(constants.map((entry) => entry.key))].join(", ");
  return literals
    .filter((entry) => changedSet.has(entry.line))
    // A literal that repeats a constant's declared value is consistent, only spelled out.
    .filter((entry) => !new RegExp(`\\b(?:${named.split(", ").join("|")})\\s*=\\s*${entry.key.replace(/[.*+?^$()|[\]\\]/gu, "\\$&")}`, "u").test(source))
    .map((entry) => ({
      kind: "inconsistent-key" as const,
      title: "Changed code addresses a store with a different key expression",
      detail: `This call keys the store with the literal ${entry.key}, while the same file keys it with ${named}. If they do not resolve to the same value the read, write, and delete paths disagree.`,
      remediation: `Use ${named} here, or state why this call intentionally addresses a different key.`,
      evidence: evidenceFor(file.path, entry.line, `keyed with ${entry.key} instead of ${named}`),
    }));
}

/** Finds text-visible defects on the changed lines of every indexed JavaScript-family file. */
export function findSourceDefects(
  index: RepositoryCodeIndex,
  files: readonly ValidationChangedFile[],
): readonly SourceDefect[] {
  const defects: SourceDefect[] = [];
  for (const file of files) {
    if (file.status === "deleted" || !JS_FAMILY.test(file.path)) continue;
    const indexed = index.files[file.path];
    if (indexed === undefined) continue;
    const lines = indexed.sourceText.split("\n");
    const changed = changedLineNumbers(file, lines.length);
    if (changed.length === 0) continue;
    defects.push(
      ...unreleasedResources(index, file, lines, changed),
      ...discardedErrors(file, lines, changed),
      ...inconsistentKeys(file, indexed.sourceText, lines, changed),
    );
  }
  return defects;
}
