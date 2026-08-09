import { createHash } from "node:crypto";
import { lstat, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";

import type {
  ChangedFile,
  ChangedRange,
  PatchRecord,
  ProposedFilePatch,
  TaskExecutionLimits,
} from "../domain/task-execution.js";
import { createRepositoryIgnore } from "../repositories/ignore-rules.js";
import { assessRepositoryContent } from "../security/content-safety.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";
import { isSensitiveRepositoryPath } from "../security/sensitive-repository-path.js";

export class RepositoryEditError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "RepositoryEditError";
  }
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function lineAt(content: string, offset: number): number {
  return content.slice(0, offset).split("\n").length;
}

function lineCount(content: string): number {
  return content === "" ? 0 : content.split("\n").length;
}

function occurrences(content: string, text: string): number {
  if (text === "") return 0;
  let count = 0;
  let offset = 0;
  while (offset <= content.length) {
    const next = content.indexOf(text, offset);
    if (next < 0) return count;
    count += 1;
    offset = next + text.length;
  }
  return count;
}

function normalizeRepositoryPath(path: string): string {
  if (path.trim() === "" || isAbsolute(path) || path.includes("\\") || path.includes("\0")) {
    throw new RepositoryEditError(`Unsafe repository path: ${path}`);
  }
  const normalized = normalize(path).split(sep).join("/");
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new RepositoryEditError(`Path escapes the repository: ${path}`);
  }
  return normalized;
}

function protectedPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.at(-1) ?? "";
  return (
    parts.includes(".git") ||
    parts.includes(".conclave") ||
    parts.includes(".codex") ||
    parts.includes(".agents") ||
    isSensitiveRepositoryPath(path) ||
    name.includes("credential") ||
    name.includes("secret")
  );
}

interface PreparedFile {
  readonly path: string;
  readonly absolutePath: string;
  readonly original: string;
  readonly resulting: string;
  readonly patches: readonly ProposedFilePatch[];
  readonly ranges: readonly ChangedRange[];
  readonly additions: number;
  readonly deletions: number;
}

export interface RepositoryFileView {
  readonly path: string;
  readonly content: string;
  readonly hash: string;
}

export class RepositoryEditor {
  readonly #root: string;
  readonly #limits: TaskExecutionLimits;
  readonly #changedPaths = new Set<string>();
  readonly #changedLinesByPath = new Map<string, number>();
  #consumedChangedLines = 0;
  #consumedPatchBytes = 0;

  private constructor(root: string, limits: TaskExecutionLimits) {
    this.#root = root;
    this.#limits = limits;
  }

  public static async create(root: string, limits: TaskExecutionLimits): Promise<RepositoryEditor> {
    return new RepositoryEditor(await resolveRepositoryRoot(root), limits);
  }

  public async read(path: string): Promise<RepositoryFileView> {
    const resolved = await this.#resolveEditableFile(path);
    const content = await readFile(resolved.absolutePath, "utf8");
    if (!assessRepositoryContent(content).externalTransmissionAllowed) {
      throw new RepositoryEditError(`Protected content cannot be exposed for editing: ${resolved.path}`);
    }
    return { path: resolved.path, content, hash: hash(content) };
  }

  public async apply(
    patches: readonly ProposedFilePatch[],
    plannedFiles: ReadonlySet<string>,
  ): Promise<PatchRecord> {
    if (patches.length === 0) throw new RepositoryEditError("At least one patch is required");
    const patchBytes = Buffer.byteLength(JSON.stringify(patches));
    if (this.#consumedPatchBytes + patchBytes > this.#limits.maxPatchBytes) {
      throw new RepositoryEditError("Task patches exceed the configured cumulative byte budget");
    }
    const byPath = new Map<string, ProposedFilePatch[]>();
    for (const patch of patches) {
      const path = normalizeRepositoryPath(patch.path);
      const existing = byPath.get(path) ?? [];
      existing.push({ ...patch, path });
      byPath.set(path, existing);
    }
    const cumulativePaths = new Set([...this.#changedPaths, ...byPath.keys()]);
    if (cumulativePaths.size > this.#limits.maxFilesChanged) {
      throw new RepositoryEditError("Task patches exceed the cumulative changed-file budget");
    }
    const prepared = await Promise.all(
      [...byPath.entries()].map(([path, filePatches]) => this.#prepare(path, filePatches)),
    );
    const totalChangedLines = prepared.reduce(
      (total, file) => total + file.additions + file.deletions,
      0,
    );
    if (this.#consumedChangedLines + totalChangedLines > this.#limits.maxTotalChangedLines) {
      throw new RepositoryEditError("Task patches exceed the cumulative changed-line budget");
    }
    for (const file of prepared) {
      const cumulativeFileLines =
        (this.#changedLinesByPath.get(file.path) ?? 0) + file.additions + file.deletions;
      if (cumulativeFileLines > this.#limits.maxChangedLinesPerFile) {
        throw new RepositoryEditError(`Task patches exceed the cumulative per-file line budget: ${file.path}`);
      }
      if (!assessRepositoryContent(file.resulting).externalTransmissionAllowed) {
        throw new RepositoryEditError(`Patch introduces protected content: ${file.path}`);
      }
    }

    const written: PreparedFile[] = [];
    try {
      for (const file of prepared) {
        const temporaryPath = join(
          dirname(file.absolutePath),
          `.conclave-edit-${String(process.pid)}-${hash(file.path).slice(0, 8)}`,
        );
        await writeFile(temporaryPath, file.resulting, { mode: (await lstat(file.absolutePath)).mode });
        await rename(temporaryPath, file.absolutePath);
        written.push(file);
      }
    } catch (error) {
      for (const file of written) await writeFile(file.absolutePath, file.original);
      throw new RepositoryEditError(
        `Patch application failed and written files were restored: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    this.#consumedPatchBytes += patchBytes;
    this.#consumedChangedLines += totalChangedLines;
    for (const file of prepared) {
      this.#changedPaths.add(file.path);
      this.#changedLinesByPath.set(
        file.path,
        (this.#changedLinesByPath.get(file.path) ?? 0) + file.additions + file.deletions,
      );
    }

    const changedFiles: ChangedFile[] = prepared.map((file) => ({
      path: file.path,
      changeType: "modified",
      originalHash: hash(file.original),
      resultingHash: hash(file.resulting),
      additions: file.additions,
      deletions: file.deletions,
      changedRanges: file.ranges,
      implementationStepIds: [...new Set(file.patches.map((patch) => patch.implementationStepId))],
      expectedByPlan: plannedFiles.has(file.path),
    }));
    return {
      id: `patch_${createHash("sha256")
        .update(changedFiles.map((file) => `${file.path}:${file.resultingHash ?? ""}`).join("\0"))
        .digest("hex")
        .slice(0, 24)}`,
      createdAt: new Date().toISOString(),
      patches,
      changedFiles,
      unifiedDiff: prepared.map((file) => this.#diff(file)).join("\n"),
      totalChangedLines,
    };
  }

  async #prepare(path: string, patches: readonly ProposedFilePatch[]): Promise<PreparedFile> {
    const resolved = await this.#resolveEditableFile(path);
    const original = await readFile(resolved.absolutePath, "utf8");
    if (!patches.every((patch) => patch.expectedHash === hash(original))) {
      throw new RepositoryEditError(`Patch hash does not match current file: ${path}`);
    }
    let resulting = original;
    const ranges: ChangedRange[] = [];
    let additions = 0;
    let deletions = 0;
    for (const patch of patches) {
      for (const replacement of patch.replacements) {
        if (replacement.oldText === "" || replacement.expectedOccurrences < 1) {
          throw new RepositoryEditError(`Invalid empty or zero-occurrence replacement: ${path}`);
        }
        const found = occurrences(resulting, replacement.oldText);
        if (found !== replacement.expectedOccurrences) {
          throw new RepositoryEditError(
            `Replacement occurrence mismatch in ${path}: expected ${String(replacement.expectedOccurrences)}, found ${String(found)}`,
          );
        }
        let searchOffset = 0;
        for (let occurrence = 0; occurrence < found; occurrence += 1) {
          const index = resulting.indexOf(replacement.oldText, searchOffset);
          if (index < 0) throw new RepositoryEditError(`Replacement became inconsistent: ${path}`);
          ranges.push({
            startLine: lineAt(resulting, index),
            originalLines: lineCount(replacement.oldText),
            resultingLines: lineCount(replacement.newText),
          });
          searchOffset = index + replacement.oldText.length;
        }
        deletions += lineCount(replacement.oldText) * found;
        additions += lineCount(replacement.newText) * found;
        resulting = resulting.split(replacement.oldText).join(replacement.newText);
      }
    }
    if (resulting === original) throw new RepositoryEditError(`Patch makes no change: ${path}`);
    return {
      path,
      absolutePath: resolved.absolutePath,
      original,
      resulting,
      patches,
      ranges,
      additions,
      deletions,
    };
  }

  async #resolveEditableFile(path: string): Promise<{ readonly path: string; readonly absolutePath: string }> {
    const normalized = normalizeRepositoryPath(path);
    if (protectedPath(normalized)) throw new RepositoryEditError(`Protected path cannot be edited: ${normalized}`);
    const ignore = await createRepositoryIgnore(this.#root);
    if (ignore.ignores(normalized)) throw new RepositoryEditError(`Ignored path cannot be edited: ${normalized}`);
    const absolutePath = resolve(this.#root, normalized);
    if (!isPathInside(this.#root, absolutePath)) throw new RepositoryEditError(`Path escapes repository: ${normalized}`);
    const stats = await lstat(absolutePath).catch(() => undefined);
    if (stats === undefined || !stats.isFile() || stats.isSymbolicLink()) {
      throw new RepositoryEditError(`Editable target must be an existing regular file: ${normalized}`);
    }
    const canonical = await realpath(absolutePath);
    if (!isPathInside(this.#root, canonical)) throw new RepositoryEditError(`Target escapes repository: ${normalized}`);
    return { path: normalized, absolutePath: canonical };
  }

  #diff(file: PreparedFile): string {
    const chunks = file.patches.flatMap((patch) =>
      patch.replacements.map(
        (replacement) =>
          `@@ step ${patch.implementationStepId} @@\n${replacement.oldText
            .split("\n")
            .map((line) => `-${line}`)
            .join("\n")}\n${replacement.newText
            .split("\n")
            .map((line) => `+${line}`)
            .join("\n")}`,
      ),
    );
    return [`--- a/${file.path}`, `+++ b/${file.path}`, ...chunks].join("\n");
  }
}
