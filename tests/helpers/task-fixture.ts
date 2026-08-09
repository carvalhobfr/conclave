import { createHash } from "node:crypto";
import { resolve } from "node:path";

import type { GenerateRequest, GenerateResponse } from "../../src/domain/provider.js";
import type { TaskAgentRole } from "../../src/domain/task-execution.js";
import { DEFAULT_TASK_EXECUTION_LIMITS } from "../../src/domain/task-execution.js";
import { TaskExecutionEngine } from "../../src/execution/task-execution-engine.js";
import { StructuredTaskAgentRuntime } from "../../src/execution/task-agent-runtime.js";
import { FakeProvider } from "../../src/providers/fake-provider.js";
import { createReasoningFixtureEngine, reasoningFixtureProvider } from "./reasoning-fixture.js";

export type TaskFixtureBehavior =
  | "wrong-then-correct"
  | "false-success"
  | "false-claim-after-correct"
  | "unrelated-then-correct";

export const taskFixturePath = resolve("tests/fixtures/task-auth");
export const taskObjective = "Fix authentication disappearing after refresh across the auth modules";

const correctAuthProvider = `import { getStoredToken } from "./storage";

export type Session = { token: string };

export function bootstrapSession(setSession: (session: Session | null) => void): void {
  const persistedToken = getStoredToken();
  setSession(persistedToken === null ? null : { token: persistedToken });
}

export function initializeAuth(setSession: (session: Session | null) => void): void {
  bootstrapSession(setSession);
}
`;

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function message(request: GenerateRequest, role: "system" | "user"): string {
  return request.messages.find((item) => item.role === role)?.content ?? "";
}

function jsonBetween(prompt: string, start: string, end: string): Record<string, unknown> {
  const startIndex = prompt.indexOf(start) + start.length;
  const endIndex = prompt.indexOf(end, startIndex);
  return JSON.parse(prompt.slice(startIndex, endIndex).trim()) as Record<string, unknown>;
}

function response(request: GenerateRequest, value: object): GenerateResponse {
  return {
    provider: "fake",
    model: request.model,
    text: JSON.stringify(value),
    usage: { inputTokens: 30, outputTokens: 20 },
  };
}

function taskProvider(behavior: TaskFixtureBehavior): FakeProvider {
  return new FakeProvider((request) => {
    const system = message(request, "system");
    const prompt = message(request, "user");
    if (system.includes("You are the Planner")) {
      const trusted = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
      const claims = trusted["supportedDiagnosisClaims"] as { id: string }[];
      const evidenceBlock = jsonBetween(
        prompt,
        "BEGIN UNTRUSTED REPOSITORY EVIDENCE",
        "END UNTRUSTED REPOSITORY EVIDENCE",
      );
      const evidence = evidenceBlock["evidence"] as { id: string }[];
      return response(request, {
        id: "plan_restore_auth",
        summary: "Restore persisted authentication during bootstrap without changing login persistence.",
        requirements: [
          {
            id: "req_restore",
            statement: "bootstrapSession reads the persisted token.",
            required: true,
            verification: {
              kind: "source-contains",
              path: "src/auth/AuthProvider.ts",
              text: "const persistedToken = getStoredToken();",
              expectation: "present",
            },
          },
          {
            id: "req_persistence",
            statement: "persistToken remains called by login.",
            required: true,
            verification: { kind: "callers", symbol: "persistToken", minimum: 1 },
          },
        ],
        constraints: [
          {
            id: "constraint_scope",
            statement: "Only AuthProvider should require a product change.",
            kind: "scope",
          },
        ],
        steps: [
          {
            id: "step_restore",
            description: "Restore the stored token in bootstrapSession.",
            targetFiles: ["src/auth/AuthProvider.ts"],
            rationaleClaimIds: [claims[1]?.id ?? claims[0]?.id],
            requirementIds: ["req_restore", "req_persistence"],
            expectedOutcome: "Refresh initializes a session from persisted authentication.",
          },
        ],
        evidenceIds: [evidence[0]?.id],
      });
    }
    if (system.includes("You are the Implementer")) {
      const trusted = jsonBetween(
        prompt,
        "BEGIN TRUSTED IMPLEMENTATION TASK",
        "END TRUSTED IMPLEMENTATION TASK",
      );
      const round = Number(trusted["round"]);
      if (behavior === "false-success") {
        return response(request, {
          summary: "Done. All tests pass.",
          patches: [],
          claims: [
            {
              id: "claim_false_success",
              statement: "Authentication restoration is fixed.",
              requirementIds: ["req_restore"],
              evidenceIds: [],
              verification: {
                kind: "source-contains",
                path: "src/auth/AuthProvider.ts",
                text: "const persistedToken = getStoredToken();",
                expectation: "present",
              },
            },
          ],
          capabilityRequests: [],
        });
      }
      const repository = jsonBetween(
        prompt,
        "BEGIN UNTRUSTED REPOSITORY FILES",
        "END UNTRUSTED REPOSITORY FILES",
      );
      const files = repository["files"] as { path: string; content: string; hash: string }[];
      const auth = files.find((file) => file.path === "src/auth/AuthProvider.ts");
      if (auth === undefined) throw new Error("AuthProvider was not supplied to Implementer");
      const patches: object[] = [];
      if (behavior === "wrong-then-correct" && round === 1) {
        patches.push({
          id: "patch_wrong_location",
          implementationStepId: "step_restore",
          path: auth.path,
          expectedHash: auth.hash,
          replacements: [
            {
              oldText: "// Refresh currently starts from an empty session instead of restoring storage.",
              newText: "// Authentication will be restored by a later initialization stage.",
              expectedOccurrences: 1,
            },
          ],
        });
      } else if (behavior === "unrelated-then-correct" && round === 1) {
        patches.push(
          {
            id: "patch_restore",
            implementationStepId: "step_restore",
            path: auth.path,
            expectedHash: auth.hash,
            replacements: [{ oldText: auth.content, newText: correctAuthProvider, expectedOccurrences: 1 }],
          },
          {
            id: "patch_unrelated",
            implementationStepId: "step_restore",
            path: "src/player/player.ts",
            expectedHash: sha256("export const playerScore = 0;\n"),
            replacements: [{ oldText: "playerScore = 0", newText: "playerScore = 99", expectedOccurrences: 1 }],
          },
        );
      } else if (behavior === "unrelated-then-correct" && round === 2) {
        const player = files.find((file) => file.path === "src/player/player.ts");
        if (player === undefined) throw new Error("Revision did not expose the unrelated file");
        patches.push({
          id: "patch_revert_unrelated",
          implementationStepId: "step_restore",
          path: player.path,
          expectedHash: player.hash,
          replacements: [{ oldText: "playerScore = 99", newText: "playerScore = 0", expectedOccurrences: 1 }],
        });
      } else {
        patches.push({
          id: "patch_restore",
          implementationStepId: "step_restore",
          path: auth.path,
          expectedHash: auth.hash,
          replacements: [{ oldText: auth.content, newText: correctAuthProvider, expectedOccurrences: 1 }],
        });
      }
      return response(request, {
        summary: round === 1 ? "Implemented the first proposed fix." : "Applied the bounded correction.",
        patches,
        claims: [
          {
            id: `claim_restore_round_${String(round)}`,
            statement: "bootstrapSession restores persisted authentication.",
            requirementIds: ["req_restore"],
            evidenceIds: [],
            verification: {
              kind: "source-contains",
              path: "src/auth/AuthProvider.ts",
              text:
                behavior === "false-claim-after-correct"
                  ? "const impossibleClaim = true;"
                  : "const persistedToken = getStoredToken();",
              expectation: "present",
            },
          },
          {
            id: `claim_persistence_round_${String(round)}`,
            statement: "Login persistence remains connected.",
            requirementIds: ["req_persistence"],
            evidenceIds: [],
            verification: { kind: "callers", symbol: "persistToken", minimum: 1 },
          },
        ],
        capabilityRequests: [
          {
            id: `apply_round_${String(round)}`,
            kind: "apply-patches",
            patchIds: patches.map((patch) => (patch as { id: string }).id),
            reason: "Apply only the exact structured patches proposed for this round.",
          },
        ],
      });
    }
    if (system.includes("You are the Reviewer")) {
      return response(request, {
        status: "approved",
        summary: "Model review approves; deterministic enforcement remains authoritative.",
        findings: [],
      });
    }
    throw new Error("Unexpected task model role");
  });
}

export async function createTaskFixtureEngine(
  behavior: TaskFixtureBehavior,
  maxImplementationRounds = behavior === "false-success" ? 1 : 2,
  onTaskRequest?: (request: GenerateRequest) => void,
): Promise<TaskExecutionEngine> {
  const reasoningProvider = reasoningFixtureProvider();
  const reasoning = await createReasoningFixtureEngine(reasoningProvider, 10, taskFixturePath);
  const scriptedProvider = taskProvider(behavior);
  const provider = onTaskRequest === undefined ? scriptedProvider : new FakeProvider((request) => {
    onTaskRequest(request);
    return scriptedProvider.generate(request);
  });
  const roles: readonly TaskAgentRole[] = ["planner", "implementer", "reviewer"];
  return new TaskExecutionEngine({
    investigator: reasoning,
    taskRuntime: new StructuredTaskAgentRuntime(
      new Map([["fake", provider]]),
      roles.map((role) => ({ role, providerId: "fake", modelId: `task-${role}` })),
      { ...DEFAULT_TASK_EXECUTION_LIMITS, maxImplementationRounds },
    ),
    permissions: {
      allowFileEdits: true,
      allowCommands: false,
      allowRepositoryScripts: false,
      allowNetwork: false,
    },
    limits: { ...DEFAULT_TASK_EXECUTION_LIMITS, maxImplementationRounds },
  });
}
