import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { GenerateRequest, GenerateResponse } from "../src/domain/provider.js";
import { DEFAULT_REASONING_LIMITS } from "../src/domain/reasoning.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { FakeProvider } from "../src/providers/fake-provider.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { StructuredAgentRuntime } from "../src/reasoning/agent-runtime.js";
import { ReasoningEngine } from "../src/reasoning/reasoning-engine.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";

const fixturePath = resolve("tests/fixtures/reasoning-auth");
const question = "Why might authentication disappear after refreshing across the auth modules?";

function systemPrompt(request: GenerateRequest): string {
  return request.messages.find((message) => message.role === "system")?.content ?? "";
}

function userPrompt(request: GenerateRequest): string {
  return request.messages.find((message) => message.role === "user")?.content ?? "";
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
    usage: { inputTokens: 20, outputTokens: 10 },
  };
}

function scriptedProvider(): FakeProvider {
  return new FakeProvider((request) => {
    const system = systemPrompt(request);
    const prompt = userPrompt(request);
    if (system.includes("You are the Investigator")) {
      const task = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
      const repository = jsonBetween(
        prompt,
        "BEGIN UNTRUSTED REPOSITORY EVIDENCE",
        "END UNTRUSTED REPOSITORY EVIDENCE",
      );
      const packed = repository["evidence"] as { evidenceIds: string[] }[];
      const evidenceId = packed[0]?.evidenceIds[0];
      if (evidenceId === undefined) throw new Error("fixture retrieval returned no evidence");
      if (String(task["question"]).startsWith("Where")) {
        return response(request, {
          summary: "A direct caller lookup is sufficient.",
          claims: [
            {
              statement: "bootstrapSession has at least one caller.",
              evidenceIds: [evidenceId],
              uncertainty: "none",
              check: { kind: "callers", symbol: "bootstrapSession", expectation: "present" },
            },
          ],
          retrievalRequests: [],
        });
      }
      return response(request, {
        summary: "Two persistence lifecycle explanations need deterministic checks.",
        claims: [
          {
            statement: "The token is never persisted.",
            evidenceIds: [evidenceId],
            uncertainty: "possible",
            check: { kind: "callers", symbol: "persistToken", expectation: "absent" },
          },
          {
            statement: "The persisted token is not restored during bootstrapSession.",
            evidenceIds: [evidenceId],
            uncertainty: "possible",
            check: {
              kind: "path",
              from: "bootstrapSession",
              to: "getStoredToken",
              maxDepth: 3,
              expectation: "absent",
            },
          },
        ],
        retrievalRequests: [],
      });
    }
    if (system.includes("You are the Judge")) {
      const adjudication = jsonBetween(
        prompt,
        "BEGIN TRUSTED ADJUDICATION RECORD",
        "END TRUSTED ADJUDICATION RECORD",
      );
      const adjudicationClaims = adjudication["claims"] as { id: string }[];
      return response(request, {
        decisions: adjudicationClaims.map((claim) => ({
          claimId: claim.id,
          status: "supported",
          explanation: "The fake judge intentionally agrees; deterministic verification must still win.",
        })),
      });
    }
    const trusted = jsonBetween(prompt, "BEGIN TRUSTED TASK", "END TRUSTED TASK");
    const claims = trusted["claims"] as { id: string; statement: string }[];
    if (system.includes("You are the Skeptic")) {
      return response(request, {
        challenges: [
          {
            claimId: claims[0]?.id,
            type: "contradictory-evidence",
            explanation: "Check whether persistToken has a caller before accepting the absence claim.",
            retrievalRequests: [{ kind: "callers", symbol: "persistToken" }],
          },
        ],
      });
    }
    if (system.includes("You are the Architect")) {
      return response(request, {
        summary: "Authentication initialization and storage cross module boundaries.",
        challenges: [],
        retrievalRequests: [
          {
            claimId: claims[1]?.id,
            request: { kind: "path", from: "bootstrapSession", to: "getStoredToken", maxDepth: 3 },
          },
        ],
      });
    }
    throw new Error("Unexpected model role");
  });
}

async function engine(provider = scriptedProvider(), maxAgentCalls = 10): Promise<{
  readonly engine: ReasoningEngine;
  readonly provider: FakeProvider;
}> {
  const embedding = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider: embedding,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(fixturePath);
  const runtime = new StructuredAgentRuntime(
    new Map([["fake", provider]]),
    ["investigator", "skeptic", "architect", "verifier", "judge"].map((role) => ({
      role: role as "investigator" | "skeptic" | "architect" | "verifier" | "judge",
      providerId: "fake",
      modelId: `fake-${role}`,
    })),
    { ...DEFAULT_REASONING_LIMITS, maxAgentCalls },
  );
  return {
    engine: new ReasoningEngine({
      retrieval: new CodeRetrievalService(indexed.index, embedding),
      runtime,
      preset: "full",
      limits: { ...DEFAULT_REASONING_LIMITS, maxAgentCalls },
    }),
    provider,
  };
}

describe("ReasoningEngine", () => {
  it("rejects a plausible wrong claim after graph retrieval and excludes it from the verdict", async () => {
    const setup = await engine();
    const result = await setup.engine.ask(question);

    expect(result.verdict.claims.rejected.map((claim) => claim.statement)).toContain(
      "The token is never persisted.",
    );
    expect(result.verdict.claims.supported.map((claim) => claim.statement)).toContain(
      "The persisted token is not restored during bootstrapSession.",
    );
    expect(result.verdict.answer).toContain("The persisted token is not restored");
    expect(result.verdict.answer).not.toContain("The token is never persisted");
    expect(result.verdict.answer).toMatch(/src\/auth\/[^:]+:\d+-\d+/);
    expect(result.state.retrievalRequests.filter((request) => request.request.kind === "callers")).toHaveLength(1);
    expect(result.state.verifications.some((verification) => verification.deterministic)).toBe(true);
    expect(result.verdict.traceSummary.agentsExecuted).toEqual(
      expect.arrayContaining(["investigator", "skeptic", "architect", "verifier", "judge"]),
    );
  });

  it("skips unnecessary review agents for a simple lookup", async () => {
    const setup = await engine();
    const result = await setup.engine.ask("Where is bootstrapSession called?");

    expect(result.state.selections.find((selection) => selection.role === "skeptic")?.selected).toBe(false);
    expect(result.state.selections.find((selection) => selection.role === "architect")?.selected).toBe(false);
  });

  it("terminates gracefully when the model-call budget is exhausted", async () => {
    const setup = await engine(scriptedProvider(), 1);
    const result = await setup.engine.ask(question);

    expect(result.terminationReason).toBe("budget-exhausted");
    expect(result.metrics.modelCalls).toBe(1);
    expect(result.trace.some((event) => event.type === "reasoning_budget_exhausted")).toBe(true);
  });
});
