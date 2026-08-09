import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { AnalysisSnapshot } from "../src/domain/adaptive-reasoning.js";
import type { GenerateRequest, GenerateResponse } from "../src/domain/provider.js";
import { FakeProvider } from "../src/providers/fake-provider.js";
import { createReasoningFixtureEngine } from "./helpers/reasoning-fixture.js";
import { createTaskFixtureEngine, taskFixturePath, taskObjective } from "./helpers/task-fixture.js";

function message(request: GenerateRequest, role: "system" | "user"): string {
  return request.messages.find((item) => item.role === role)?.content ?? "";
}

function firstEvidenceId(prompt: string): string {
  const start = "BEGIN UNTRUSTED REPOSITORY EVIDENCE";
  const end = "END UNTRUSTED REPOSITORY EVIDENCE";
  const value = JSON.parse(prompt.slice(prompt.indexOf(start) + start.length, prompt.indexOf(end)).trim()) as { evidence: { evidenceIds: string[] }[] };
  const id = value.evidence[0]?.evidenceIds[0];
  if (id === undefined) throw new Error("expected fixture evidence");
  return id;
}

function response(request: GenerateRequest, value: object): GenerateResponse {
  return { provider: "fake", model: request.model, text: JSON.stringify(value), usage: { inputTokens: 12, outputTokens: 6 } };
}

function partialProvider(onJudge: (request: GenerateRequest) => Promise<GenerateResponse>): FakeProvider {
  return new FakeProvider((request) => {
    const system = message(request, "system");
    if (system.includes("You are the Investigator")) {
      return response(request, {
        summary: "Login persistence is statically checkable before deeper review.",
        claims: [{ statement: "Login persists the token.", evidenceIds: [firstEvidenceId(message(request, "user"))], uncertainty: "none", check: { kind: "callers", symbol: "persistToken", expectation: "present" } }],
        retrievalRequests: [],
      });
    }
    if (system.includes("You are the Skeptic")) return response(request, { challenges: [] });
    if (system.includes("You are the Architect")) return response(request, { summary: "No additional lifecycle request is material.", challenges: [], retrievalRequests: [] });
    if (system.includes("You are the Judge")) return onJudge(request);
    throw new Error("unexpected model role");
  });
}

describe("cancellation, timeout, and safe partial results", () => {
  it("propagates AbortSignal through the active provider call and preserves verified evidence", async () => {
    let judgeStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => { judgeStarted = resolveStarted; });
    let providerSignal: AbortSignal | undefined;
    const provider = partialProvider((request) => {
      providerSignal = request.signal;
      judgeStarted?.();
      return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(request.signal?.reason instanceof Error ? request.signal.reason : new Error("cancelled")), { once: true }));
    });
    const controller = new AbortController();
    const snapshots: { readonly status: string; readonly supported: number; readonly uncertain: number }[] = [];
    const running = (await createReasoningFixtureEngine(provider)).ask(
      "Why might authentication disappear after refresh?",
      "conclave",
      {
        depth: "deep",
        intent: "investigate",
        signal: controller.signal,
        onSnapshot: (snapshot) => snapshots.push({ status: snapshot.status, supported: snapshot.supportedClaims.length, uncertain: snapshot.uncertainClaims.length }),
      },
    );
    await started;
    controller.abort(new DOMException("cancelled by test", "AbortError"));
    const result = await running;

    expect(providerSignal?.aborted).toBe(true);
    expect(result.terminationReason).toBe("cancelled");
    expect(result.analysis.finalSnapshot.status).toBe("cancelled");
    expect(result.verdict.claims.supported[0]?.statement).toBe("Login persists the token.");
    expect(result.verdict.evidence.length).toBeGreaterThan(0);
    expect(snapshots.at(-1)).toMatchObject({ status: "cancelled", supported: 1 });
  });

  it("returns timed-out with supported partial evidence when optional final review times out", async () => {
    const result = await (await createReasoningFixtureEngine(partialProvider(() => Promise.reject(new Error("timeout"))))).ask(
      "Why might authentication disappear after refresh?",
      "conclave",
      { depth: "deep", intent: "investigate" },
    );

    expect(result.terminationReason).toBe("timed-out");
    expect(result.analysis.finalSnapshot.status).toBe("timed-out");
    expect(result.verdict.claims.supported).toHaveLength(1);
    expect(result.verdict.traceSummary.modelCalls).toBe(3);
  });

  it("publishes supported, rejected, and uncertain claims with the actual remaining check", async () => {
    const provider = new FakeProvider((request) => {
      const system = message(request, "system");
      if (system.includes("You are the Investigator")) {
        const evidenceId = firstEvidenceId(message(request, "user"));
        return response(request, {
          summary: "Mixed deterministic and unresolved findings.",
          claims: [
            { statement: "Login persists the token.", evidenceIds: [evidenceId], uncertainty: "none", check: { kind: "callers", symbol: "persistToken", expectation: "present" } },
            { statement: "The token is never persisted.", evidenceIds: [evidenceId], uncertainty: "possible", check: { kind: "callers", symbol: "persistToken", expectation: "absent" } },
            { statement: "A runtime-only restoration hook may exist.", evidenceIds: [evidenceId], uncertainty: "hypothesis" },
          ],
          retrievalRequests: [],
        });
      }
      if (system.includes("You are the Skeptic")) return response(request, { challenges: [] });
      if (system.includes("You are the Architect")) return response(request, { summary: "No additional static path.", challenges: [], retrievalRequests: [] });
      if (system.includes("You are the Verifier")) {
        const trusted = JSON.parse(message(request, "user").split("BEGIN TRUSTED VERIFICATION RECORD")[1]?.split("END TRUSTED VERIFICATION RECORD")[0]?.trim() ?? "{}") as { claims?: { id: string }[] };
        const unresolved = trusted.claims?.at(-1)?.id;
        return response(request, { decisions: unresolved === undefined ? [] : [{ claimId: unresolved, outcome: "uncertain", method: "semantic", explanation: "Runtime behavior is not statically observable.", evidenceIds: [], graphEdgeIds: [] }] });
      }
      throw new Error("unexpected role");
    });
    const snapshots: AnalysisSnapshot[] = [];
    const result = await (await createReasoningFixtureEngine(provider)).ask(
      "Why might authentication disappear after refresh?",
      "conclave",
      { depth: "balanced", intent: "investigate", onSnapshot: (snapshot) => snapshots.push(snapshot) },
    );
    const final = snapshots.at(-1);

    expect(result.verdict.claims.supported).toHaveLength(1);
    expect(result.verdict.claims.rejected).toHaveLength(1);
    expect(result.verdict.claims.uncertain).toHaveLength(1);
    expect(final?.supportedClaims).toHaveLength(1);
    expect(final?.rejectedClaims).toHaveLength(1);
    expect(final?.uncertainClaims).toHaveLength(1);
    expect(final?.evidence.length).toBeGreaterThan(0);
    expect(final?.remainingChecks[0]).toMatch(/resolve material claim/u);
  });

  it("cancels Task planning before mutation and leaves the source repository untouched", async () => {
    const path = resolve(taskFixturePath, "src/auth/AuthProvider.ts");
    const before = await readFile(path, "utf8");
    const controller = new AbortController();
    controller.abort(new DOMException("cancel task", "AbortError"));
    const engine = await createTaskFixtureEngine("wrong-then-correct");

    await expect(engine.execute({ intent: "task", repositoryRoot: taskFixturePath, objective: taskObjective, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(await readFile(path, "utf8")).toBe(before);
  });

  it("cancels a Task revision before its next mutation and leaves the source repository untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-cancel-revision-"));
    await cp(taskFixturePath, root, { recursive: true });
    const path = join(root, "src/auth/AuthProvider.ts");
    try {
      const before = await readFile(path, "utf8");
      const controller = new AbortController();
      let implementerCalls = 0;
      const engine = await createTaskFixtureEngine("wrong-then-correct", 2, (request) => {
        if (message(request, "system").includes("You are the Implementer") && ++implementerCalls === 2) {
          controller.abort(new DOMException("cancel revision", "AbortError"));
        }
      });

      await expect(engine.execute({ intent: "task", repositoryRoot: root, objective: taskObjective, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(implementerCalls).toBe(2);
      expect(await readFile(path, "utf8")).toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
