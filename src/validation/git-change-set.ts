import { spawn } from "node:child_process";
import { posix, resolve } from "node:path";

import type {
  ChangeSet,
  ChangeSource,
  ValidationChangedFile,
  ValidationChangedFileStatus,
  ChangedLineRange,
} from "../domain/validation.js";

const MAX_GIT_OUTPUT_BYTES = 5_000_000;
const GIT_TIMEOUT_MS = 15_000;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}+-]*$/u;

interface GitOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function safeRef(value: string, label: string): string {
  if (!SAFE_REF.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new Error(label + " contains an unsafe Git ref");
  }
  return value;
}

function runGit(repositoryRoot: string, args: readonly string[]): Promise<GitOutput> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("git", [...args], {
      cwd: resolve(repositoryRoot),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        PATH: process.env["PATH"] ?? "",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        LC_ALL: "C",
      },
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
      if (outputBytes + chunk.length > MAX_GIT_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        throw new Error("Git output exceeded the validation limit");
      }
      outputBytes += chunk.length;
      if (target === "stdout") stdoutChunks.push(chunk);
      else stderrChunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        append("stdout", chunk);
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      try {
        append("stderr", chunk);
      } catch (error) {
        if (!settled) {
          settled = true;
          reject(error);
        }
      }
    });
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Git change collection timed out"));
      }
    }, GIT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const output = {
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      };
      if (code !== 0) {
        reject(new Error("Git command failed: " + output.stderr.trim()));
        return;
      }
      resolvePromise(output);
    });
  });
}

function normalizedPath(raw: string): string | undefined {
  if (raw === "/dev/null") return undefined;
  let value = raw.trim();
  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") value = parsed;
    } catch {
      return undefined;
    }
  }
  if (value.startsWith("a/") || value.startsWith("b/")) value = value.slice(2);
  const normalized = posix.normalize(value.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized.startsWith("/")) return undefined;
  return normalized;
}

function statusFromCode(code: string): ValidationChangedFileStatus {
  switch (code[0]) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "unknown";
  }
}

export function parseNameStatus(output: string): readonly ValidationValidationChangedFile[] {
  const values = output.split("\0").filter((value) => value !== "");
  const files: ValidationChangedFile[] = [];
  for (let index = 0; index < values.length;) {
    const code = values[index];
    if (code === undefined) break;
    index += 1;
    const status = statusFromCode(code);
    if (status === "renamed" || status === "copied") {
      const previousPath = values[index];
      const path = values[index + 1];
      index += 2;
      if (previousPath === undefined || path === undefined) continue;
      files.push({ path, previousPath, status, hunks: [] });
      continue;
    }
    const path = values[index];
    index += 1;
    if (path !== undefined) files.push({ path, status, hunks: [] });
  }
  return files;
}

export function parseUnifiedDiff(
  patch: string,
  nameStatus: readonly ValidationValidationChangedFile[],
): readonly ValidationValidationChangedFile[] {
  const files = new Map(nameStatus.map((file) => [file.path, { ...file, hunks: [...file.hunks] }]));
  let oldPath: string | undefined;
  let currentPath: string | undefined;
  for (const line of patch.split("\n")) {
    if (line.startsWith("--- ")) {
      oldPath = normalizedPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      currentPath = normalizedPath(line.slice(4)) ?? oldPath;
      if (currentPath !== undefined && !files.has(currentPath)) {
        files.set(currentPath, { path: currentPath, status: "unknown", hunks: [] });
      }
      continue;
    }
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u.exec(line);
    if (match === null || currentPath === undefined) continue;
    const range: ChangedLineRange = {
      oldStart: Number(match[1]),
      oldCount: Number(match[2] ?? "1"),
      newStart: Number(match[3]),
      newCount: Number(match[4] ?? "1"),
    };
    const file = files.get(currentPath);
    if (file !== undefined) file.hunks.push(range);
  }
  return [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function sourceArguments(source: ChangeSource): {
  readonly patch: readonly string[];
  readonly names: readonly string[];
} {
  const commonPatch = ["--no-ext-diff", "--no-color", "--unified=0"];
  const commonNames = ["--no-ext-diff", "--name-status", "-z"];
  switch (source.kind) {
    case "working":
      return {
        patch: ["diff", ...commonPatch, "--"],
        names: ["diff", ...commonNames, "--"],
      };
    case "staged":
      return {
        patch: ["diff", "--cached", ...commonPatch, "--"],
        names: ["diff", "--cached", ...commonNames, "--"],
      };
    case "branch": {
      const base = safeRef(source.base, "Branch");
      return {
        patch: ["diff", ...commonPatch, base + "...HEAD", "--"],
        names: ["diff", ...commonNames, base + "...HEAD", "--"],
      };
    }
    case "commit": {
      const commit = safeRef(source.commit, "Commit");
      return {
        patch: ["show", "--format=", ...commonPatch.slice(1), commit, "--"],
        names: ["show", "--format=", ...commonNames.slice(1), commit, "--"],
      };
    }
  }
}

export class GitChangeSetService {
  public async collect(repositoryRoot: string, source: ChangeSource): Promise<ChangeSet> {
    const root = resolve(repositoryRoot);
    const headSha = (await runGit(root, ["rev-parse", "HEAD"])).stdout.trim();
    if (source.kind === "commit") {
      const targetSha = (await runGit(root, ["rev-parse", safeRef(source.commit, "Commit")])).stdout.trim();
      if (targetSha !== headSha) {
        throw new Error("--commit must identify the checked-out HEAD so graph evidence matches the change");
      }
    }
    const args = sourceArguments(source);
    const [patch, names] = await Promise.all([
      runGit(root, args.patch),
      runGit(root, args.names),
    ]);
    const namedFiles = parseNameStatus(names.stdout);
    return {
      source,
      headSha,
      files: parseUnifiedDiff(patch.stdout, namedFiles),
      patch: patch.stdout,
      collectedAt: new Date().toISOString(),
    };
  }
}
