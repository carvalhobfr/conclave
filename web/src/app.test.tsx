// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProductRunView, ProjectView, RuntimeModeView } from "../../src/web/contracts.js";
import { App } from "./app.js";

const project: ProjectView = {
  id: "demo:project", name: "auth-repository", path: "Demo repository · auth lifecycle", source: "demo", gitStatus: "demo", languages: ["typescript"], indexedFiles: 5, symbols: 6, graphNodes: 11, graphEdges: 22, updatedAt: "now",
};
const runtime: RuntimeModeView = { active: "demo", available: false, message: "Demo", roles: [] };
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
    const body = url === "/api/runtime" ? runtime : url === "/api/projects/demo" ? project : run;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }));
}

describe("Conclave product UI", () => {
  it("keeps Task explicit and repository-script permission default-deny", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Task" }));

    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Plan only/i }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Allow scoped file edits/i }).disabled).toBe(true);
    expect(screen.getByText(/Repository scripts execute repository code and are not fully sandboxed/i)).toBeTruthy();
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
});
