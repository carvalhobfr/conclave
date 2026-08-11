import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  GitChangeSetService,
  parseNameStatus,
  parseUnifiedDiff,
} from "../src/validation/git-change-set.js";

const execFileAsync = promisify(execFile);

async function runGit(root: string, args: readonly string[]): Promise<void> {
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

async function gitFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-git-change-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "session.ts"), "export const session = \"old\";\n");
  await runGit(root, ["init", "-b", "master"]);
  await runGit(root, ["add", "--", "src/session.ts"]);
  await runGit(root, ["commit", "-m", "baseline"]);
  await writeFile(join(root, "src", "session.ts"), "export const session = \"restored\";\n");
  return root;
}

describe("GitChangeSetService parsers", () => {
  it("parses NUL-delimited statuses and zero-context hunk ranges", () => {
    const statuses = parseNameStatus(
      "M\0src/session.ts\0R100\0src/old.ts\0src/new.ts\0",
    );
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/session.ts b/src/session.ts",
        "--- a/src/session.ts",
        "+++ b/src/session.ts",
        "@@ -2,1 +2,2 @@",
        "-  return oldValue;",
        "+  const value = restore();",
        "+  return value;",
        "",
      ].join("\n"),
      statuses,
    );

    expect(files).toEqual([
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        status: "renamed",
        hunks: [],
      },
      {
        path: "src/session.ts",
        status: "modified",
        hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 2 }],
      },
    ]);
  });
  it("collects a real tracked working-tree diff and refuses silent untracked omissions", async () => {
    const root = await gitFixture();
    const service = new GitChangeSetService();

    const collected = await service.collect(root, { kind: "working" });
    expect(collected.headSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(collected.files).toEqual([
      expect.objectContaining({
        path: "src/session.ts",
        status: "modified",
        hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
      }),
    ]);
    expect(collected.patch).toContain('session = "restored"');

    await writeFile(join(root, "src", "untracked.ts"), "export const unsafeToIgnore = true;\n");
    await expect(service.collect(root, { kind: "working" })).rejects.toThrow(
      "Untracked files are not silently excluded",
    );
  });

});
