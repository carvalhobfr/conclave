// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProductRunView, ProjectView, RuntimeModeView, ValidationRunView } from "../../src/web/contracts.js";
import { App } from "./app.js";

const project: ProjectView = {
  id: "demo:project", name: "auth-repository", path: "Demo repository · auth lifecycle", source: "demo", gitStatus: "demo", languages: ["typescript"], indexedFiles: 5, symbols: 6, graphNodes: 11, graphEdges: 22, updatedAt: "now",
};
const runtime: RuntimeModeView = { active: "demo", available: false, message: "Demo", roles: [] };
const validation: ValidationRunView = {
  intent: "validate",
  verdict: "pass",
  headline: "Change is consistent with the objective",
  explanation: "Conclave found no deterministic contradiction, scope violation, or unresolved graph risk.",
  recommendation: "The change can proceed to human review with the evidence below.",
  counts: { blocking: 0, warning: 0, supportedClaims: 1, totalClaims: 1 },
  report: {
    schemaVersion: 1,
    verdict: "pass",
    summary: "PASS: 0 blocking, 0 warning; 2 impacted file(s).",
    objective: "Keep authentication after refresh.",
    changeSet: {
      source: { kind: "branch", base: "master" },
      headSha: "abc123",
      files: [{ path: "src/auth/AuthProvider.ts", status: "modified", hunks: [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }] }],
      collectedAt: "now",
      patchBytes: 120,
    },
    findings: [],
    claims: [{
      claim: { id: "restore", statement: "bootstrapSession exists.", check: { kind: "symbol-exists", symbol: "bootstrapSession", expectation: "present" } },
      outcome: "supported",
      explanation: "The indexed project contains the claimed symbol.",
      evidence: [{ path: "src/auth/AuthProvider.ts", startLine: 5, endLine: 8, symbol: "bootstrapSession", reason: "Indexed symbol evidence" }],
    }],
    impact: {
      changedSymbols: ["bootstrapSession"],
      impactedFiles: ["src/auth/AuthProvider.ts", "src/routes/App.tsx"],
      impactedSymbols: ["App", "bootstrapSession"],
    },
    metrics: {
      filesChanged: 1,
      symbolsChanged: 1,
      impactedFiles: 2,
      impactedSymbols: 2,
      graphEdgesInspected: 12,
      deterministicChecks: 1,
      durationMs: 2,
    },
    trustBoundary: {
      deterministic: true,
      reasoningModelCalls: 0,
      repositoryScriptsExecuted: false,
      knowledge: {
        parser: "typescript",
        graph: "syntax-aware",
        embedding: { id: "local-hash", kind: "deterministic-feature-hash", remoteCalls: 0 },
      },
    },
  },
  patch: "diff --git a/src/auth/AuthProvider.ts b/src/auth/AuthProvider.ts",
  handoff: "Review the Conclave evidence before merging.",
  demo: true,
};

const run: ProductRunView = {
  intent: "investigate", status: "completed", title: "Investigated verdict", answer: "Evidence-backed diagnosis.",
  claims: [
    { id: "supported", statement: "Storage persists tokens.", status: "supported", role: "investigator", evidenceIds: ["e1"], challengeCount: 0, verificationCount: 1 },
    { id: "rejected", statement: "The token is never persisted.", status: "rejected", role: "investigator", evidenceIds: ["e1"], challengeCount: 1, verificationCount: 1 },
    { id: "uncertain", statement: "A runtime race may remain.", status: "uncertain", role: "architect", evidenceIds: [], challengeCount: 0, verificationCount: 1 },
  ],
  evidence: [{ id: "e1", path: "src/auth/AuthProvider.ts", startLine: 5, endLine: 8, symbol: "bootstrapSession", excerpt: "setSession(null);", origin: "structural-unit" }],
  trace: [], retrieval: { operations: [{ label: "graph callers", status: "executed" }], evidenceCount: 1, sourceBytes: 18, approximateTokens: 5 }, metrics: [],
  graph: { query: "bootstrapSession", status: "resolved", nodes: [], edges: [] },
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockFetch(): void {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const body = url === "/api/runtime" ? runtime : url === "/api/projects/demo" ? project : url === "/api/validate" ? validation : url.startsWith("/api/history") ? [] : run;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }));
}

describe("Conclave product UI", () => {
  it("makes Validate primary and shows a decision summary before raw data", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");

    expect(screen.getByRole("heading", { name: "Review this change" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));

    expect(await screen.findByRole("region", { name: "Validation summary" })).toBeTruthy();
    expect(screen.getByText("Change is consistent with the objective")).toBeTruthy();
    expect(screen.getByText(/Reasoning model calls: 0/i)).toBeTruthy();
    expect(screen.getByText("0", { selector: ".decision-metrics strong" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Raw validation report" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Raw report" }));
    expect(screen.getByRole("region", { name: "Raw validation report" })).toBeTruthy();
    expect(screen.getByText(/"verdict": "pass"/i)).toBeTruthy();
  });

  it("keeps the product read-only and does not expose Task Mode", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    expect(within(screen.getByRole("navigation", { name: "Workspace navigation" })).queryByRole("button", { name: "Task" })).toBeNull();
    expect(screen.queryByText(/Allow scoped file edits/i)).toBeNull();
  });

  it("shows supported, rejected, and uncertain claims without hiding disagreement", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Investigate" }));
    fireEvent.click(screen.getByRole("button", { name: "Run investigate" }));

    await waitFor(() => expect(screen.getByText("The token is never persisted.")).toBeTruthy());
    expect(screen.getByLabelText("rejected")).toBeTruthy();
    expect(screen.getByLabelText("uncertain")).toBeTruthy();
    const evidenceButton = screen.getAllByRole("button", { name: "Evidence" }).at(0);
    if (evidenceButton === undefined) throw new Error("Expected evidence button");
    fireEvent.click(evidenceButton);
    expect(await screen.findByText("setSession(null);")).toBeTruthy();
  });

  it("keeps graph, retrieval, and server-owned provider settings reachable by keyboard-labelled controls", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Investigate" }));
    fireEvent.click(screen.getByRole("button", { name: "Run investigate" }));
    await screen.findByText("Evidence-backed diagnosis.");
    fireEvent.click(screen.getByRole("tab", { name: "Retrieval" }));
    expect(screen.getByText("Retrieval inspector")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(screen.getByRole("region", { name: "Graph explorer" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: /Settings/ }));
    expect(screen.getByRole("region", { name: "Provider and role configuration" })).toBeTruthy();
    expect(screen.getByText(/Browser code never receives provider credentials/i)).toBeTruthy();
  });
});
