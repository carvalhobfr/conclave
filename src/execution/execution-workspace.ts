import { cp, lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

import type { RepositoryExecutionSnapshot } from "../domain/task-execution.js";
import { createRepositoryIgnore } from "../repositories/ignore-rules.js";
import { isSensitiveRepositoryPath } from "../security/sensitive-repository-path.js";
import { isPathInside, resolveRepositoryRoot } from "../security/path-policy.js";

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(executable: string, args: readonly string[], cwd: string): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, [...args], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env["PATH"] ?? "" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

function dirtyPaths(output: string): readonly string[] {
  return output
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter((path) => path !== "");
}

export interface PreparedExecutionWorkspace {
  readonly status: "ready" | "blocked";
  readonly snapshot: RepositoryExecutionSnapshot;
  readonly cleanup: () => Promise<void>;
}

export class ExecutionWorkspaceManager {
  public async prepare(requestedRoot: string): Promise<PreparedExecutionWorkspace> {
    const originalRoot = await resolveRepositoryRoot(requestedRoot);
    const gitRootResult = await run("git", ["rev-parse", "--show-toplevel"], originalRoot);
    if (gitRootResult.exitCode === 0) {
      const gitRoot = await realpath(gitRootResult.stdout.trim());
      if (gitRoot !== originalRoot) {
        return this.#blocked(originalRoot, true, [relative(gitRoot, originalRoot)]);
      }
      const status = await run(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        originalRoot,
      );
      if (status.exitCode !== 0) {
        return this.#blocked(originalRoot, true, ["git-status-unavailable"]);
      }
      const dirty = dirtyPaths(status.stdout);
      const branch = await run("git", ["branch", "--show-current"], originalRoot);
      const revision = await run("git", ["rev-parse", "HEAD"], originalRoot);
      if (dirty.length > 0) {
        return {
          status: "blocked",
          snapshot: {
            originalRoot,
            isolation: "none",
            gitBacked: true,
            ...(branch.stdout.trim() === "" ? {} : { branch: branch.stdout.trim() }),
            ...(revision.exitCode === 0 ? { baseRevision: revision.stdout.trim() } : {}),
            dirtyPaths: dirty,
          },
          cleanup: () => Promise.resolve(),
        };
      }
      const temporaryRoot = await mkdtemp(join(tmpdir(), "conclave-task-"));
      const executionRoot = join(temporaryRoot, "worktree");
      const worktree = await run(
        "git",
        ["worktree", "add", "--detach", executionRoot, "HEAD"],
        originalRoot,
      );
      if (worktree.exitCode !== 0) {
        await this.#removeTemporaryRoot(temporaryRoot);
        return this.#blocked(originalRoot, true, ["git-worktree-unavailable"]);
      }
      return {
        status: "ready",
        snapshot: {
          originalRoot,
          executionRoot,
          isolation: "git-worktree",
          gitBacked: true,
          ...(branch.stdout.trim() === "" ? {} : { branch: branch.stdout.trim() }),
          ...(revision.exitCode === 0 ? { baseRevision: revision.stdout.trim() } : {}),
          dirtyPaths: [],
        },
        cleanup: async () => {
          await run("git", ["worktree", "remove", "--force", executionRoot], originalRoot);
          await this.#removeTemporaryRoot(temporaryRoot);
        },
      };
    }

    const temporaryRoot = await mkdtemp(join(tmpdir(), "conclave-task-"));
    const executionRoot = join(temporaryRoot, "repository");
    const ignore = await createRepositoryIgnore(originalRoot);
    await cp(originalRoot, executionRoot, {
      recursive: true,
      dereference: false,
      filter: async (source) => {
        const stats = await lstat(source);
        if (stats.isSymbolicLink()) return false;
        const repositoryPath = relative(originalRoot, source).split(sep).join("/");
        if (repositoryPath === "") return true;
        return !isSensitiveRepositoryPath(repositoryPath) && !ignore.ignores(`${repositoryPath}${stats.isDirectory() ? "/" : ""}`);
      },
    });
    return {
      status: "ready",
      snapshot: {
        originalRoot,
        executionRoot,
        isolation: "copied-directory",
        gitBacked: false,
        dirtyPaths: [],
      },
      cleanup: () => this.#removeTemporaryRoot(temporaryRoot),
    };
  }

  #blocked(
    originalRoot: string,
    gitBacked: boolean,
    paths: readonly string[],
  ): PreparedExecutionWorkspace {
    return {
      status: "blocked",
      snapshot: {
        originalRoot,
        isolation: "none",
        gitBacked,
        dirtyPaths: paths,
      },
      cleanup: () => Promise.resolve(),
    };
  }

  async #removeTemporaryRoot(path: string): Promise<void> {
    const canonicalParent = resolve(tmpdir());
    const candidate = resolve(path);
    if (!isPathInside(canonicalParent, candidate) || !basename(candidate).startsWith("conclave-task-")) {
      throw new Error("Refusing to remove an invalid execution workspace path");
    }
    await rm(candidate, { recursive: true, force: true });
  }
}
