import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { inferredReviewObjective, inspectRepository } from "../src/workflow/repository-inspector.js";

const execFileAsync = promisify(execFile);

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Conclave Test",
      GIT_AUTHOR_EMAIL: "conclave@example.invalid",
      GIT_COMMITTER_NAME: "Conclave Test",
      GIT_COMMITTER_EMAIL: "conclave@example.invalid",
    },
  });
}

describe("repository inspector", () => {
  it("detects a base and preserves staged, unstaged, and untracked status columns", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-repository-inspector-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "tracked.ts"), "export const value = 1;\n");
    await git(root, ["init", "-b", "main"]);
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "baseline behavior"]);
    await git(root, ["switch", "-c", "feature"]);
    await writeFile(join(root, "src", "tracked.ts"), "export const value = 2;\n");
    await writeFile(join(root, "src", "staged.ts"), "export const staged = true;\n");
    await writeFile(join(root, "src", "new.ts"), "export const fresh = true;\n");
    await git(root, ["add", "src/staged.ts"]);

    const result = await inspectRepository(join(root, "src"));
    expect(result).toMatchObject({
      root: await realpath(root),
      currentBranch: "feature",
      defaultBase: "main",
      status: { staged: 1, unstaged: 1, untracked: 1 },
      latestCommit: "baseline behavior",
    });
    expect(inferredReviewObjective(result)).toContain("baseline behavior");
  });
});
