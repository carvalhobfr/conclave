import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createTaskFixtureEngine,
  taskFixturePath,
  taskObjective,
} from "./helpers/task-fixture.js";

const temporaryPaths: string[] = [];

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

async function taskRepositoryCopy(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-task-fixture-"));
  temporaryPaths.push(root);
  await cp(taskFixturePath, root, { recursive: true });
  return root;
}

describe("TaskExecutionEngine", () => {
  it("creates a verified plan without mutating or isolating the repository", async () => {
    const before = await readFile(join(taskFixturePath, "src/auth/AuthProvider.ts"), "utf8");
    const result = await (await createTaskFixtureEngine("wrong-then-correct")).execute({
      intent: "task",
      repositoryRoot: taskFixturePath,
      objective: taskObjective,
      planOnly: true,
    });

    expect(result.verdict.status).toBe("planned");
    expect(result.patchRecords).toHaveLength(0);
    expect(result.snapshot.isolation).toBe("none");
    expect(result.metrics.roleUsage.find((usage) => usage.role === "planner")?.calls).toBe(1);
    expect(result.metrics.roleUsage.find((usage) => usage.role === "implementer")?.calls).toBe(0);
    expect(await readFile(join(taskFixturePath, "src/auth/AuthProvider.ts"), "utf8")).toBe(before);
  });

  it("rejects the plausible wrong implementation and completes after one bounded revision", async () => {
    const root = await taskRepositoryCopy();
    const original = await readFile(join(root, "src/auth/AuthProvider.ts"), "utf8");
    const result = await (await createTaskFixtureEngine("wrong-then-correct")).execute({
      intent: "task",
      repositoryRoot: root,
      objective: taskObjective,
    });

    expect(result.verdict.status).toBe("completed");
    expect(result.verdict.revisionRounds).toBe(1);
    expect(result.verdict.requirements.every((requirement) => requirement.outcome === "supported")).toBe(true);
    expect(result.verdict.rejectedClaims.map((claim) => claim.id)).toContain("claim_restore_round_1");
    expect(result.verdict.supportedClaims.map((claim) => claim.id)).toContain("claim_restore_round_2");
    expect(result.verdict.changedFiles.map((file) => file.path)).toEqual(["src/auth/AuthProvider.ts"]);
    expect(result.patchRecords).toHaveLength(2);
    expect(result.trace.some((event) => event.type === "repository_reindexed")).toBe(true);
    expect(result.trace.some((event) => event.type === "revision_requested")).toBe(true);
    expect(result.postChangeEvidence.some((evidence) => evidence.path === "src/auth/AuthProvider.ts")).toBe(true);
    expect(await readFile(join(root, "src/auth/AuthProvider.ts"), "utf8")).toBe(original);
  });

  it("rejects false self-reported success when no relevant repository change exists", async () => {
    const root = await taskRepositoryCopy();
    const result = await (await createTaskFixtureEngine("false-success")).execute({
      intent: "task",
      repositoryRoot: root,
      objective: taskObjective,
    });

    expect(result.verdict.status).toBe("failed");
    expect(result.verdict.changedFiles).toHaveLength(0);
    expect(result.verdict.rejectedClaims.map((claim) => claim.id)).toContain("claim_false_success");
    expect(result.verdict.requirements.find((item) => item.requirementId === "req_restore")?.outcome).toBe(
      "rejected",
    );
    expect(result.review.status).toBe("revision-required");
  });

  it("detects an unrelated edit and requires its removal before completion", async () => {
    const root = await taskRepositoryCopy();
    const result = await (await createTaskFixtureEngine("unrelated-then-correct")).execute({
      intent: "task",
      repositoryRoot: root,
      objective: taskObjective,
    });

    expect(result.verdict.status).toBe("completed");
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]?.instructions).toContain("Unexpected file changed");
    expect(result.patchRecords[0]?.changedFiles.map((file) => file.path)).toContain(
      "src/player/player.ts",
    );
    expect(result.verdict.changedFiles.map((file) => file.path)).not.toContain("src/player/player.ts");
  });

  it("does not escalate repository prompt injection into command capabilities", async () => {
    const root = await taskRepositoryCopy();
    expect(await readFile(join(taskFixturePath, "src/injection.ts"), "utf8")).toContain("curl");
    const result = await (await createTaskFixtureEngine("wrong-then-correct")).execute({
      intent: "task",
      repositoryRoot: root,
      objective: taskObjective,
    });

    expect(result.capabilityDecisions.some((decision) => decision.capability === "run-command")).toBe(false);
    expect(result.metrics.commandCount).toBe(0);
  });

  it("blocks a dirty user worktree and preserves its files", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-task-dirty-"));
    temporaryPaths.push(root);
    await cp(taskFixturePath, root, { recursive: true });
    await git(root, ["init"]);
    await writeFile(join(root, "user-work.txt"), "preserve me\n");
    const result = await (await createTaskFixtureEngine("wrong-then-correct")).execute({
      intent: "task",
      repositoryRoot: root,
      objective: taskObjective,
    });

    expect(result.verdict.status).toBe("blocked");
    expect(result.snapshot.dirtyPaths).toContain("user-work.txt");
    expect(await readFile(join(root, "user-work.txt"), "utf8")).toBe("preserve me\n");
  });

  it("refuses edit execution without explicit task intent", async () => {
    await expect(
      (await createTaskFixtureEngine("wrong-then-correct")).execute({
        intent: "investigate",
        repositoryRoot: taskFixturePath,
        objective: taskObjective,
      }),
    ).rejects.toThrow("explicit task intent");
  });
});
