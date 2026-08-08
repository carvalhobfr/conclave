import { spawn } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ExecutionWorkspaceManager } from "../src/execution/execution-workspace.js";

const temporaryPaths: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "conclave-workspace-test-"));
  temporaryPaths.push(path);
  return path;
}

function git(cwd: string, args: readonly string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], { cwd, shell: false, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git exited ${String(code)}`));
    });
  });
}

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("ExecutionWorkspaceManager", () => {
  it("copies a non-Git repository and never mutates the original", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "file.ts"), "export const value = 1;\n");

    const workspace = await new ExecutionWorkspaceManager().prepare(root);
    expect(workspace.status).toBe("ready");
    expect(workspace.snapshot.isolation).toBe("copied-directory");
    const executionRoot = workspace.snapshot.executionRoot;
    expect(executionRoot).toBeDefined();
    await writeFile(join(executionRoot!, "file.ts"), "export const value = 2;\n");

    expect(await readFile(join(root, "file.ts"), "utf8")).toContain("value = 1");
    await workspace.cleanup();
    await expect(access(executionRoot!)).rejects.toThrow();
  });

  it("uses a detached Git worktree for a clean repository", async () => {
    const root = await temporaryDirectory();
    await writeFile(join(root, "file.ts"), "export const value = 1;\n");
    await git(root, ["init"]);
    await git(root, ["add", "file.ts"]);
    await git(root, [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);

    const workspace = await new ExecutionWorkspaceManager().prepare(root);
    expect(workspace.status).toBe("ready");
    expect(workspace.snapshot.isolation).toBe("git-worktree");
    await writeFile(join(workspace.snapshot.executionRoot!, "file.ts"), "changed\n");
    expect(await readFile(join(root, "file.ts"), "utf8")).toContain("value = 1");
    await workspace.cleanup();
  });

  it("blocks a dirty Git repository and preserves user work", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "src"));
    await git(root, ["init"]);
    await writeFile(join(root, "src", "user-change.ts"), "const userWork = true;\n");

    const workspace = await new ExecutionWorkspaceManager().prepare(root);

    expect(workspace.status).toBe("blocked");
    expect(workspace.snapshot.dirtyPaths).toContain("src/user-change.ts");
    expect(await readFile(join(root, "src", "user-change.ts"), "utf8")).toContain("userWork");
  });
});
