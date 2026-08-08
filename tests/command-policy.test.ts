import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_TASK_EXECUTION_LIMITS,
  type AllowedCommand,
  type ExecutionPermissions,
} from "../src/domain/task-execution.js";
import { ExecutionCapabilityPolicy } from "../src/execution/capability-policy.js";
import { CommandPolicy } from "../src/execution/command-policy.js";
import { StructuredCommandRunner } from "../src/execution/structured-command-runner.js";

const temporaryPaths: string[] = [];
const allPermissions: ExecutionPermissions = {
  allowFileEdits: true,
  allowCommands: true,
  allowRepositoryScripts: true,
  allowNetwork: true,
};

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-command-test-"));
  temporaryPaths.push(root);
  await writeFile(join(root, "valid.js"), "export const value = 1;\n");
  await writeFile(
    join(root, "slow.test.mjs"),
    'import test from "node:test";\ntest("slow", async () => new Promise((resolve) => setTimeout(resolve, 5000)));\n',
  );
  await writeFile(
    join(root, "output.test.mjs"),
    'import test from "node:test";\ntest("output", () => console.log("x".repeat(100000)));\n',
  );
  await writeFile(
    join(root, "environment.test.mjs"),
    'import assert from "node:assert/strict";\nimport test from "node:test";\ntest("env", () => assert.equal(process.env.CONCLAVE_API_KEY, undefined));\n',
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      scripts: {
        presafe: 'node -e "require(\\"node:fs\\").writeFileSync(\\"hook-ran\\", \\"x\\")"',
        safe: "node --version",
        postsafe: 'node -e "require(\\"node:fs\\").writeFileSync(\\"hook-ran\\", \\"x\\")"',
      },
    }),
  );
  return root;
}

async function policy(
  root: string,
  permissions: ExecutionPermissions = allPermissions,
  timeoutMs = 10_000,
  outputBytes = 8_000,
): Promise<CommandPolicy> {
  return CommandPolicy.create({
    repositoryRoot: root,
    permissions,
    limits: {
      ...DEFAULT_TASK_EXECUTION_LIMITS,
      maxCommandDurationMs: timeoutMs,
      maxCommandOutputBytes: outputBytes,
    },
    allowedPackageScripts: ["safe"],
  });
}

afterEach(async () => {
  delete process.env["CONCLAVE_API_KEY"];
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("structured command policy", () => {
  it("runs an allowed static command without a shell", async () => {
    const root = await fixture();
    const authorization = await (await policy(root)).authorize("check_1", {
      kind: "node-syntax",
      path: "valid.js",
    });

    expect(authorization.decision.outcome).toBe("allowed");
    const result = await new StructuredCommandRunner().run(authorization.approved!);
    expect(result.status).toBe("passed");
    expect(result.exitCode).toBe(0);
  });

  it("rejects unknown executables, dangerous scripts, path escape, and networked repository code", async () => {
    const root = await fixture();
    const commandPolicy = await policy(root, { ...allPermissions, allowNetwork: false });
    const unknown = await commandPolicy.authorize("unknown", {
      kind: "git",
      args: ["reset", "--hard"],
    } as unknown as AllowedCommand);
    const dangerous = await commandPolicy.authorize("dangerous", {
      kind: "package-script",
      name: "git-reset",
    });
    const escape = await commandPolicy.authorize("escape", {
      kind: "node-syntax",
      path: "../outside.js",
    });
    const networkDenied = await commandPolicy.authorize("network", {
      kind: "node-test",
      path: "environment.test.mjs",
    });

    expect(unknown.decision.outcome).toBe("rejected");
    expect(dangerous.decision.outcome).toBe("rejected");
    expect(escape.decision.outcome).toBe("rejected");
    expect(networkDenied.decision.reason).toContain("network permission");
  });

  it("keeps shell metacharacters inside one argv path", async () => {
    const root = await fixture();
    const filename = "safe;touch escaped.js";
    await writeFile(join(root, filename), "const safe = true;\n");
    const authorization = await (await policy(root)).authorize("metachar", {
      kind: "node-syntax",
      path: filename,
    });

    const result = await new StructuredCommandRunner().run(authorization.approved!);
    expect(result.status).toBe("passed");
    await expect(access(join(root, "escaped.js"))).rejects.toThrow();
  });

  it("terminates timed-out processes and truncates oversized output", async () => {
    const root = await fixture();
    const timeoutPolicy = await policy(root, allPermissions, 100, 1_024);
    const outputPolicy = await policy(root, allPermissions, 10_000, 1_024);
    const slow = await timeoutPolicy.authorize("slow", { kind: "node-test", path: "slow.test.mjs" });
    const large = await outputPolicy.authorize("large", {
      kind: "node-test",
      path: "output.test.mjs",
    });

    const slowResult = await new StructuredCommandRunner().run(slow.approved!);
    const largeResult = await new StructuredCommandRunner().run(large.approved!);
    expect(slowResult.status).toBe("timed-out");
    expect(largeResult.status).toBe("passed");
    expect(largeResult.outputTruncated).toBe(true);
    expect(Buffer.byteLength(largeResult.stdout) + Buffer.byteLength(largeResult.stderr)).toBeLessThanOrEqual(1_024);
  });

  it("filters parent credentials from explicitly approved repository processes", async () => {
    const root = await fixture();
    process.env["CONCLAVE_API_KEY"] = "must-not-leak";
    const authorization = await (await policy(root)).authorize("env", {
      kind: "node-test",
      path: "environment.test.mjs",
    });
    const result = await new StructuredCommandRunner().run(authorization.approved!);

    expect(result.status).toBe("passed");
    expect(result.stdout).not.toContain("must-not-leak");
  });

  it("runs only an explicitly allowlisted package script and disables lifecycle hooks", async () => {
    const root = await fixture();
    const authorization = await (await policy(root)).authorize("package", {
      kind: "package-script",
      name: "safe",
    });
    const result = await new StructuredCommandRunner().run(authorization.approved!);

    expect(result.status).toBe("passed");
    await expect(access(join(root, "hook-ran"))).rejects.toThrow();
  });

  it("requires capability policy approval before patches or commands", async () => {
    const root = await fixture();
    const commandPolicy = await policy(root);
    const capabilityPolicy = new ExecutionCapabilityPolicy(allPermissions, commandPolicy);
    const context = {
      knownPatchIds: new Set(["patch_known"]),
      allowedReadPaths: new Set(["valid.js"]),
      retrievalRequestsRemaining: 1,
    };
    const unknownPatch = await capabilityPolicy.authorize(
      { id: "apply_1", kind: "apply-patches", patchIds: ["patch_unknown"], reason: "edit" },
      context,
    );
    const knownPatch = await capabilityPolicy.authorize(
      { id: "apply_2", kind: "apply-patches", patchIds: ["patch_known"], reason: "edit" },
      context,
    );

    expect(unknownPatch.decision.outcome).toBe("rejected");
    expect(knownPatch.decision.outcome).toBe("allowed");
  });
});
