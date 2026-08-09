import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { GitChangeSetService } from "../src/review/change-set-service.js";

function git(root: string, ...args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile("git", [...args], { cwd: root }, (error, stdout, stderr) => {
    if (error !== null) reject(new Error(stderr || error.message));
    else resolve(stdout);
  }));
}

describe("GitChangeSetService", () => {
  it("loads working-tree, staged, branch, commit, and explicit ChangeSets", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-changeset-"));
    try {
      await git(root, "init");
      await git(root, "config", "user.email", "conclave@example.test");
      await git(root, "config", "user.name", "Conclave Test");
      await writeFile(join(root, "feature.ts"), "export const value = 1;\n");
      await git(root, "add", "feature.ts");
      await git(root, "commit", "-m", "base");
      const base = (await git(root, "rev-parse", "HEAD")).trim();

      await writeFile(join(root, "feature.ts"), "export const value = 2;\n");
      const service = new GitChangeSetService();
      const working = await service.load(root, { kind: "working-tree" });
      expect(working.source.kind).toBe("working-tree");
      expect(working.unifiedDiff).toContain("+export const value = 2");

      await git(root, "add", "feature.ts");
      const staged = await service.load(root, { kind: "staged" });
      expect(staged.unifiedDiff).toContain("feature.ts");
      await writeFile(join(root, "feature.ts"), "export const value = 3;\n");
      const stagedWithDrift = await service.load(root, { kind: "staged" });
      expect(stagedWithDrift.limitations.join(" ")).toMatch(/differs from the staged snapshot/i);
      await writeFile(join(root, "feature.ts"), "export const value = 2;\n");
      await git(root, "commit", "-m", "change");
      const target = (await git(root, "rev-parse", "HEAD")).trim();

      const branch = await service.load(root, { kind: "branch", base, head: "HEAD" });
      const commit = await service.load(root, { kind: "commit", base, target });
      expect(branch.unifiedDiff).toContain("+export const value = 2");
      expect(commit.unifiedDiff).toBe(branch.unifiedDiff);

      const explicit = await service.load(root, { kind: "explicit", label: "pasted" }, { explicitDiff: commit.unifiedDiff });
      expect(explicit.source).toEqual({ kind: "explicit", label: "pasted" });
      expect(explicit.unifiedDiff).toBe(commit.unifiedDiff);

      await writeFile(join(root, ".env"), "API_KEY=must-not-appear\n");
      const protectedWorking = await service.load(root, { kind: "working-tree" });
      expect(protectedWorking.excludedSensitivePaths).toContain(".env");
      expect(protectedWorking.unifiedDiff).not.toContain("must-not-appear");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
