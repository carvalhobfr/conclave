import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_TASK_EXECUTION_LIMITS } from "../src/domain/task-execution.js";
import { RepositoryEditor } from "../src/execution/repository-editor.js";

const temporaryPaths: string[] = [];

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-editor-test-"));
  temporaryPaths.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "session.ts"), "export const restored = false;\n");
  return root;
}

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("RepositoryEditor", () => {
  it("applies exact hash-bound replacements and records scope", async () => {
    const root = await fixture();
    const editor = await RepositoryEditor.create(root, DEFAULT_TASK_EXECUTION_LIMITS);
    const original = "export const restored = false;\n";
    const record = await editor.apply(
      [
        {
          id: "patch_1",
          implementationStepId: "step_1",
          path: "src/session.ts",
          expectedHash: hash(original),
          replacements: [
            { oldText: "restored = false", newText: "restored = true", expectedOccurrences: 1 },
          ],
        },
      ],
      new Set(["src/session.ts"]),
    );

    expect((await editor.read("src/session.ts")).content).toContain("restored = true");
    expect(record.changedFiles[0]).toEqual(
      expect.objectContaining({ path: "src/session.ts", expectedByPlan: true }),
    );
    expect(record.unifiedDiff).toContain("+restored = true");
  });

  it("marks edits outside the verified plan as unexpected", async () => {
    const root = await fixture();
    const editor = await RepositoryEditor.create(root, DEFAULT_TASK_EXECUTION_LIMITS);
    const view = await editor.read("src/session.ts");
    const record = await editor.apply(
      [
        {
          id: "patch_1",
          implementationStepId: "step_1",
          path: view.path,
          expectedHash: view.hash,
          replacements: [{ oldText: "false", newText: "true", expectedOccurrences: 1 }],
        },
      ],
      new Set(),
    );

    expect(record.changedFiles[0]?.expectedByPlan).toBe(false);
  });

  it("rejects traversal, ignored files, symlinks, stale hashes, and excessive diffs", async () => {
    const root = await fixture();
    await writeFile(join(root, ".env"), "TOKEN=secret\n");
    await symlink(join(root, "src", "session.ts"), join(root, "src", "link.ts"));
    const editor = await RepositoryEditor.create(root, {
      ...DEFAULT_TASK_EXECUTION_LIMITS,
      maxTotalChangedLines: 1,
    });

    await expect(editor.read("../outside.ts")).rejects.toThrow("escapes");
    await expect(editor.read(".env")).rejects.toThrow("Protected path");
    await expect(editor.read("src/link.ts")).rejects.toThrow("regular file");
    await expect(
      editor.apply(
        [
          {
            id: "patch_bad",
            implementationStepId: "step_1",
            path: "src/session.ts",
            expectedHash: "stale",
            replacements: [{ oldText: "false", newText: "true", expectedOccurrences: 1 }],
          },
        ],
        new Set(["src/session.ts"]),
      ),
    ).rejects.toThrow("hash does not match");

    const view = await editor.read("src/session.ts");
    await expect(
      editor.apply(
        [
          {
            id: "patch_large",
            implementationStepId: "step_1",
            path: view.path,
            expectedHash: view.hash,
            replacements: [
              { oldText: "false", newText: "true\ntrue\ntrue", expectedOccurrences: 1 },
            ],
          },
        ],
        new Set([view.path]),
      ),
    ).rejects.toThrow("changed-line budget");
  });

  it("enforces diff budgets cumulatively across revision rounds", async () => {
    const root = await fixture();
    const editor = await RepositoryEditor.create(root, {
      ...DEFAULT_TASK_EXECUTION_LIMITS,
      maxTotalChangedLines: 3,
    });
    const first = await editor.read("src/session.ts");
    await editor.apply(
      [
        {
          id: "patch_round_1",
          implementationStepId: "step_1",
          path: first.path,
          expectedHash: first.hash,
          replacements: [{ oldText: "false", newText: "true", expectedOccurrences: 1 }],
        },
      ],
      new Set([first.path]),
    );
    const second = await editor.read("src/session.ts");
    await expect(
      editor.apply(
        [
          {
            id: "patch_round_2",
            implementationStepId: "step_1",
            path: second.path,
            expectedHash: second.hash,
            replacements: [{ oldText: "true", newText: "false", expectedOccurrences: 1 }],
          },
        ],
        new Set([second.path]),
      ),
    ).rejects.toThrow("cumulative changed-line budget");
  });
});
