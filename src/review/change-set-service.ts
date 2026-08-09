import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";

import type { ChangeSet, ChangeSetSource } from "../domain/review.js";
import { isSensitiveRepositoryPath } from "../security/sensitive-repository-path.js";

const MAX_GIT_OUTPUT_BYTES = 2_000_000;
const MAX_CHANGED_PATHS = 2_000;
const GIT_TIMEOUT_MS = 20_000;
const GIT_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]{0,199}$/u;

export class ChangeSetError extends Error {
  public constructor(public readonly code: "not-git" | "invalid-ref" | "git-failed" | "diff-too-large", message: string) {
    super(message);
    this.name = "ChangeSetError";
  }
}

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

function assertRef(value: string, label: string): string {
  if (!GIT_REF.test(value) || value.startsWith("-")) {
    throw new ChangeSetError("invalid-ref", `${label} is not a supported Git ref`);
  }
  return value;
}

async function git(
  root: string,
  args: readonly string[],
  allowedExitCodes: readonly number[] = [0],
  signal?: AbortSignal,
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...(signal === undefined ? {} : { signal }) });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error !== undefined) reject(error);
      else if (result !== undefined) resolve(result);
    };
    const capture = (target: Buffer[]) => (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(new ChangeSetError("diff-too-large", "Git change output exceeds the bounded review limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", (error) => finish(error));
    child.once("close", (code) => {
      const exitCode = code ?? -1;
      const result = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), exitCode };
      if (!allowedExitCodes.includes(exitCode)) {
        finish(new ChangeSetError("git-failed", result.stderr.trim().slice(0, 500) || `git exited with ${String(exitCode)}`));
      } else finish(undefined, result);
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new ChangeSetError("git-failed", "Git change inspection timed out"));
    }, GIT_TIMEOUT_MS);
    timeout.unref();
  });
}

function diffBaseArguments(source: Exclude<ChangeSetSource, { readonly kind: "explicit" }>, namesOnly: boolean): readonly string[] {
  const formatting = ["--no-ext-diff", "--no-color", namesOnly ? "--name-only" : "--unified=3", ...(namesOnly ? ["-z"] : [])];
  switch (source.kind) {
    case "working-tree": return ["diff", ...formatting, "HEAD"];
    case "staged": return ["diff", ...formatting, "--cached"];
    case "branch": return ["diff", ...formatting, `${assertRef(source.base, "Base branch")}...${assertRef(source.head ?? "HEAD", "Head branch")}`];
    case "commit": return ["diff", ...formatting, assertRef(source.base, "Base commit"), assertRef(source.target, "Target commit")];
  }
}

function changeSetId(root: string, source: ChangeSetSource, diff: string): string {
  return `changeset_${createHash("sha256").update(`${root}\0${JSON.stringify(source)}\0${diff}`).digest("hex").slice(0, 24)}`;
}

function paths(value: string): readonly string[] {
  return [...new Set(value.split("\0").filter(Boolean))].slice(0, MAX_CHANGED_PATHS);
}

export class GitChangeSetService {
  public async load(
    repositoryRoot: string,
    source: ChangeSetSource,
    options: { readonly explicitDiff?: string; readonly signal?: AbortSignal } = {},
  ): Promise<ChangeSet> {
    const root = await realpath(repositoryRoot);
    if (source.kind === "explicit") {
      const unifiedDiff = options.explicitDiff ?? "";
      if (Buffer.byteLength(unifiedDiff) > MAX_GIT_OUTPUT_BYTES) throw new ChangeSetError("diff-too-large", "Explicit diff exceeds the bounded review limit");
      return {
        id: changeSetId(root, source, unifiedDiff), repositoryRoot: root, source, unifiedDiff,
        createdAt: new Date().toISOString(), excludedSensitivePaths: [], limitations: [],
      };
    }

    const topLevel = await git(root, ["rev-parse", "--show-toplevel"], [0], options.signal).catch((error: unknown) => {
      if (error instanceof ChangeSetError) throw new ChangeSetError("not-git", "The selected project is not a readable Git working tree");
      throw error;
    });
    if (await realpath(topLevel.stdout.trim()) !== root) {
      throw new ChangeSetError("not-git", "Review must run from the opened repository root");
    }
    const nameResult = await git(root, diffBaseArguments(source, true), [0], options.signal);
    const changed = paths(nameResult.stdout);
    const excludedSensitivePaths = changed.filter(isSensitiveRepositoryPath);
    const included = changed.filter((path) => !isSensitiveRepositoryPath(path));
    const limitations: string[] = [];
    if (changed.length >= MAX_CHANGED_PATHS) limitations.push(`Changed-path discovery was capped at ${String(MAX_CHANGED_PATHS)} paths.`);
    if (excludedSensitivePaths.length > 0) limitations.push(`${String(excludedSensitivePaths.length)} sensitive path${excludedSensitivePaths.length === 1 ? " was" : "s were"} excluded from diff content.`);
    if (source.kind === "staged") {
      const unstaged = paths((await git(root, ["diff", "--no-ext-diff", "--name-only", "-z"], [0], options.signal)).stdout);
      const overlap = included.filter((path) => unstaged.includes(path));
      if (overlap.length > 0) limitations.push(`The opened working tree differs from the staged snapshot for ${String(overlap.length)} reviewed path${overlap.length === 1 ? "" : "s"}; changed-symbol resolution may not represent the staged content.`);
    }
    if (source.kind === "branch" || source.kind === "commit") {
      const targetRef = source.kind === "branch" ? source.head ?? "HEAD" : source.target;
      const target = (await git(root, ["rev-parse", assertRef(targetRef, "Comparison target")], [0], options.signal)).stdout.trim();
      const current = (await git(root, ["rev-parse", "HEAD"], [0], options.signal)).stdout.trim();
      const dirty = (await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], [0], options.signal)).stdout !== "";
      if (target !== current || dirty) limitations.push("The comparison target is not the clean opened working-tree state; changed-symbol and impact resolution may not represent the target snapshot.");
    }

    let unifiedDiff = "";
    if (included.length > 0) {
      unifiedDiff = (await git(root, [...diffBaseArguments(source, false), "--", ...included], [0], options.signal)).stdout;
    }
    if (source.kind === "working-tree") {
      const untracked = paths((await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], [0], options.signal)).stdout);
      for (const path of untracked.slice(0, MAX_CHANGED_PATHS - included.length)) {
        if (isSensitiveRepositoryPath(path)) {
          if (!excludedSensitivePaths.includes(path)) excludedSensitivePaths.push(path);
          continue;
        }
        const addition = await git(root, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--unified=3", "--", "/dev/null", path], [0, 1], options.signal);
        if (Buffer.byteLength(unifiedDiff) + Buffer.byteLength(addition.stdout) > MAX_GIT_OUTPUT_BYTES) {
          throw new ChangeSetError("diff-too-large", "Working-tree diff exceeds the bounded review limit");
        }
        unifiedDiff += addition.stdout;
      }
    }
    return {
      id: changeSetId(root, source, unifiedDiff), repositoryRoot: root, source, unifiedDiff,
      createdAt: new Date().toISOString(), excludedSensitivePaths, limitations,
    };
  }
}
