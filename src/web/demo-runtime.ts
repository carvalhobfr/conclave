import { createHash } from "node:crypto";

import { TypeScriptCodeParser } from "../code-intelligence/typescript-parser.js";
import type { GenerateRequest, GenerateResponse } from "../domain/provider.js";
import type { AgentRole } from "../domain/reasoning.js";
import { DEFAULT_REASONING_LIMITS } from "../domain/reasoning.js";
import type { ExecutionPermissions, TaskAgentRole } from "../domain/task-execution.js";
import { DEFAULT_TASK_EXECUTION_LIMITS } from "../domain/task-execution.js";
import { LocalHashEmbeddingProvider } from "../embeddings/local-hash-embedding.js";
import { TaskExecutionEngine } from "../execution/task-execution-engine.js";
import { StructuredTaskAgentRuntime } from "../execution/task-agent-runtime.js";
import { InMemoryCodeIndexStore } from "../indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../indexing/repository-indexer.js";
import { FakeProvider } from "../providers/fake-provider.js";
import { LocalFolderRepository } from "../repositories/local-folder-repository.js";
import { StructuredAgentRuntime } from "../reasoning/agent-runtime.js";
import { ReasoningEngine } from "../reasoning/reasoning-engine.js";
import { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";

function message(request: GenerateRequest, role: "system" | "user"): string {
  return request.messages.find((item) => item.role === role)?.content ?? "";
}

function jsonBetween(prompt: string, start: string, end: string): Record<string, unknown> {
  const startIndex = prompt.indexOf(start) + start.length;
  const endIndex = prompt.indexOf(end, startIndex);
  if (startIndex < start.length || endIndex < 0) throw new Error(`Demo prompt is missing ${start}`);
  return JSON.parse(prompt.slice(startIndex, endIndex).trim()) as Record<string, unknown>;
}

function response(request: GenerateRequest, value: object): GenerateResponse {
  return {
    provider: "fake",
    model: request.model,
    text: JSON.stringify(value),
    usage: { inputTokens: 20, outputTokens: 10 },
  };
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

const correctedProvider = `import { getStoredToken } from "./storage";

export type Session = { token: string };

export function bootstrapSession(setSession: (session: Session | null) => void): void {
  const persistedToken = getStoredToken();
  setSession(persistedToken === null ? null : { token: persistedToken });
}

export function initializeAuth(setSession: (session: Session | null) => void): void {
  bootstrapSession(setSession);
}
`;

export function createDemoReasoningEngine(root: string): Promise<ReasoningEngine> {
  const provider = new FakeProvider((request) => {
    const system = message(request, "system");
    const prompt = message(request, "user");
    if (system.includes("You are the Investigator")) {
      const task = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
      const repository = jsonBetween(prompt, "BEGIN UNTRUSTED REPOSITORY EVIDENCE", "END UNTRUSTED REPOSITORY EVIDENCE");
      const packed = repository["evidence"] as { evidenceIds: string[] }[];
      const evidenceId = packed[0]?.evidenceIds[0];
      if (evidenceId === undefined) throw new Error("Demo retrieval returned no evidence");
      if (String(task["question"]).startsWith("Where")) {
        return response(request, {
          summary: "A direct caller lookup is sufficient.",
          claims: [{ statement: "bootstrapSession has at least one caller.", evidenceIds: [evidenceId], uncertainty: "none", check: { kind: "callers", symbol: "bootstrapSession", expectation: "present" } }],
          retrievalRequests: [],
        });
      }
      return response(request, {
        summary: "Two persistence lifecycle explanations need deterministic checks.",
        claims: [
          { statement: "The token is never persisted.", evidenceIds: [evidenceId], uncertainty: "possible", check: { kind: "callers", symbol: "persistToken", expectation: "absent" } },
          { statement: "The persisted token is not restored during bootstrapSession.", evidenceIds: [evidenceId], uncertainty: "possible", check: { kind: "path", from: "bootstrapSession", to: "getStoredToken", maxDepth: 3, expectation: "absent" } },
        ],
        retrievalRequests: [],
      });
    }
    if (system.includes("You are the Judge")) {
      const record = jsonBetween(prompt, "BEGIN TRUSTED ADJUDICATION RECORD", "END TRUSTED ADJUDICATION RECORD");
      const claims = record["claims"] as { id: string }[];
      return response(request, { decisions: claims.map((claim) => ({ claimId: claim.id, status: "supported", explanation: "Demo judge response; deterministic verification remains authoritative." })) });
    }
    const trusted = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
    const claims = trusted["claims"] as { id: string }[];
    if (system.includes("You are the Skeptic")) {
      return response(request, { challenges: [{ claimId: claims[0]?.id, type: "contradictory-evidence", explanation: "Check persistToken callers before accepting the absence claim.", retrievalRequests: [{ kind: "callers", symbol: "persistToken" }] }] });
    }
    if (system.includes("You are the Architect")) {
      return response(request, { summary: "Authentication initialization and storage cross module boundaries.", challenges: [], retrievalRequests: [{ claimId: claims[1]?.id, request: { kind: "path", from: "bootstrapSession", to: "getStoredToken", maxDepth: 3 } }] });
    }
    throw new Error("Unexpected Demo reasoning role");
  });
  return createReasoning(root, provider);
}

async function createReasoning(root: string, provider: FakeProvider): Promise<ReasoningEngine> {
  const embedding = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({ repositorySource: new LocalFolderRepository(), parser: new TypeScriptCodeParser(), embeddingProvider: embedding, indexStore: new InMemoryCodeIndexStore() }).index(root);
  const roles: readonly AgentRole[] = ["investigator", "skeptic", "architect", "verifier", "judge"];
  return new ReasoningEngine({
    retrieval: new CodeRetrievalService(indexed.index, embedding),
    runtime: new StructuredAgentRuntime(new Map([["fake", provider]]), roles.map((role) => ({ role, providerId: "fake", modelId: `demo-${role}` })), DEFAULT_REASONING_LIMITS),
    preset: "full",
    limits: DEFAULT_REASONING_LIMITS,
  });
}

export async function createDemoTaskEngine(
  root: string,
  permissions: ExecutionPermissions,
): Promise<TaskExecutionEngine> {
  const investigator = await createDemoReasoningEngine(root);
  const provider = new FakeProvider((request) => {
    const system = message(request, "system");
    const prompt = message(request, "user");
    if (system.includes("You are the Planner")) {
      const trusted = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
      const claims = trusted["supportedDiagnosisClaims"] as { id: string }[];
      const evidence = jsonBetween(prompt, "BEGIN UNTRUSTED REPOSITORY EVIDENCE", "END UNTRUSTED REPOSITORY EVIDENCE")["evidence"] as { id: string }[];
      return response(request, {
        id: "plan_restore_auth", summary: "Restore persisted authentication during bootstrap without changing login persistence.",
        requirements: [
          { id: "req_restore", statement: "bootstrapSession reads the persisted token.", required: true, verification: { kind: "source-contains", path: "src/auth/AuthProvider.ts", text: "const persistedToken = getStoredToken();", expectation: "present" } },
          { id: "req_persistence", statement: "persistToken remains called by login.", required: true, verification: { kind: "callers", symbol: "persistToken", minimum: 1 } },
        ],
        constraints: [{ id: "constraint_scope", statement: "Only AuthProvider should require a product change.", kind: "scope" }],
        steps: [{ id: "step_restore", description: "Restore the stored token in bootstrapSession.", targetFiles: ["src/auth/AuthProvider.ts"], rationaleClaimIds: [claims[0]?.id], requirementIds: ["req_restore", "req_persistence"], expectedOutcome: "Refresh initializes a session from persisted authentication." }],
        evidenceIds: [evidence[0]?.id],
      });
    }
    if (system.includes("You are the Implementer")) {
      const trusted = jsonBetween(prompt, "BEGIN TRUSTED IMPLEMENTATION TASK", "END TRUSTED IMPLEMENTATION TASK");
      const round = Number(trusted["round"]);
      const files = (jsonBetween(prompt, "BEGIN UNTRUSTED REPOSITORY FILES", "END UNTRUSTED REPOSITORY FILES")["files"] as { path: string; content: string; hash: string }[]);
      const auth = files.find((file) => file.path === "src/auth/AuthProvider.ts");
      if (auth === undefined) throw new Error("Demo implementer did not receive AuthProvider");
      const patch = round === 1
        ? { id: "patch_wrong", implementationStepId: "step_restore", path: auth.path, expectedHash: auth.hash, replacements: [{ oldText: "// Refresh currently starts from an empty session instead of restoring storage.", newText: "// Authentication will be restored by a later initialization stage.", expectedOccurrences: 1 }] }
        : { id: "patch_correct", implementationStepId: "step_restore", path: auth.path, expectedHash: auth.hash, replacements: [{ oldText: auth.content, newText: correctedProvider, expectedOccurrences: 1 }] };
      return response(request, {
        summary: round === 1 ? "Implemented an initial hypothesis." : "Applied the scoped correction.",
        patches: [patch],
        claims: [{ id: `claim_restore_${String(round)}`, statement: "bootstrapSession restores persisted authentication.", requirementIds: ["req_restore"], evidenceIds: [], verification: { kind: "source-contains", path: "src/auth/AuthProvider.ts", text: "const persistedToken = getStoredToken();", expectation: "present" } }],
        capabilityRequests: [{ id: `apply_${String(round)}`, kind: "apply-patches", patchIds: [patch.id], reason: "Apply the exact scoped patch." }],
      });
    }
    if (system.includes("You are the Reviewer")) {
      const uncertain = prompt.includes("Keep runtime behavior uncertain");
      return response(request, {
        status: uncertain ? "uncertain" : "approved",
        summary: uncertain
          ? "Source requirements are supported, but runtime behavior remains intentionally unexecuted."
          : "Review is advisory; deterministic verification is authoritative.",
        findings: [],
      });
    }
    throw new Error("Unexpected Demo task role");
  });
  const roles: readonly TaskAgentRole[] = ["planner", "implementer", "reviewer"];
  return new TaskExecutionEngine({
    investigator,
    taskRuntime: new StructuredTaskAgentRuntime(new Map([["fake", provider]]), roles.map((role) => ({ role, providerId: "fake", modelId: `demo-${role}` })), DEFAULT_TASK_EXECUTION_LIMITS),
    permissions,
    limits: DEFAULT_TASK_EXECUTION_LIMITS,
  });
}

export function expectedDemoProviderHash(): string {
  return hash(correctedProvider);
}
