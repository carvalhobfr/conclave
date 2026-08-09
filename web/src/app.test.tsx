// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProductRunView, ProjectView, ProviderModelsView, ProviderRole, ProviderSettingsView, RuntimeModeView } from "../../src/web/contracts.js";
import { App } from "./app.js";

const project: ProjectView = {
  id: "demo:project", name: "auth-repository", path: "Demo repository · auth lifecycle", source: "demo", gitStatus: "demo", languages: ["typescript"], indexedFiles: 5, symbols: 6, graphNodes: 11, graphEdges: 22, updatedAt: "now",
};
const runtime: RuntimeModeView = { active: "demo", available: false, message: "Demo", roles: [] };
const providerSettings: ProviderSettingsView = {
  maximumSets: 5,
  environment: { available: false, mode: "demo", label: "Environment fallback", credentialConfigured: false, locked: true, roles: [], message: "Not configured" },
  catalog: [{ id: "openai", name: "OpenAI", local: false, requiresApiKey: true, defaultBaseUrl: "https://api.openai.com/v1", modelPlaceholder: "gpt-5-mini" }],
  sets: [],
};
const freeProviderSettings: ProviderSettingsView = {
  ...providerSettings,
  environment: {
    available: true,
    mode: "free",
    label: "Free Mode",
    provider: "OpenCode Zen",
    model: "DeepSeek V4 Flash Free",
    credentialConfigured: true,
    locked: true,
    roles: [{ role: "implementer", provider: "OpenCode Zen", model: "North Mini Code Free" }],
    message: "Powered by Conclave. Free Mode uses external inference.",
  },
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
const startedRun = { id: "run-1", intent: "investigate" as const, status: "running" as const, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", progress: [] };
const completedRun = { ...startedRun, status: "completed" as const, result: run };
const providerRoles: readonly ProviderRole[] = ["investigator", "skeptic", "architect", "verifier", "judge", "planner", "implementer", "reviewer"];

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function mockFetch(settings: ProviderSettingsView = providerSettings): void {
  vi.stubGlobal("fetch", vi.fn((url: string) => {
    const body = url === "/api/runtime" ? runtime : url === "/api/settings/providers" ? settings : url === "/api/projects/demo" ? project : url === "/api/runs" ? startedRun : url === "/api/runs/run-1" ? completedRun : run;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  }));
}

describe("Conclave product UI", () => {
  it("defaults analysis depth to Auto and explains every explicit choice", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");

    expect(screen.getByRole<HTMLInputElement>("radio", { name: /Auto/ }).checked).toBe(true);
    expect(screen.getByText("Chooses the smallest useful reasoning workflow.")).toBeTruthy();
    expect(screen.getByText(/Adds adversarial review/i)).toBeTruthy();
  });

  it("sends real cancellation from the visible progress surface", async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const body = url === "/api/runtime" ? runtime
        : url === "/api/settings/providers" ? providerSettings
          : url === "/api/projects/demo" ? project
            : url === "/api/runs" ? startedRun
              : url === "/api/runs/run-1" && init?.method === "DELETE" ? { ...startedRun, status: "cancelling" as const }
                : startedRun;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(screen.getByRole("button", { name: "Run ask" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel analysis" }));

    await screen.findByText("Cancelling…");
    expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-1", { method: "DELETE" });
  });

  it("keeps Task explicit and repository-script permission default-deny", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Task" }));

    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Plan only/i }).checked).toBe(true);
    expect(screen.getByRole<HTMLInputElement>("checkbox", { name: /Allow scoped file edits/i }).disabled).toBe(true);
    expect(screen.getByText(/Repository scripts execute repository code and are not fully sandboxed/i)).toBeTruthy();
  });

  it("provides first-class Review and Decide workspaces", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    const navigation = within(screen.getByRole("navigation", { name: "Workspace navigation" }));

    fireEvent.click(navigation.getByRole("button", { name: "Review" }));
    expect(screen.getByRole("region", { name: "Review workspace" })).toBeTruthy();
    expect(screen.getByText("Review a real ChangeSet")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Working tree" })).toBeTruthy();

    fireEvent.click(navigation.getByRole("button", { name: "Decide" }));
    expect(screen.getByRole("region", { name: "Decide workspace" })).toBeTruthy();
    expect(screen.getByText("Challenge a proposal before implementation")).toBeTruthy();
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
    expect(await screen.findByText(/credentials never come back to the browser/i)).toBeTruthy();
  });

  it("opens repositories through a device folder picker instead of a typed path", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    expect(screen.getAllByRole("button", { name: "Choose repository" }).length).toBeGreaterThan(0);
    expect(screen.queryByPlaceholderText("/path/to/repository")).toBeNull();
  });

  it("does not read sensitive files selected by the browser folder picker", async () => {
    const importedPayloads: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/projects/import") {
        if (typeof init?.body !== "string") throw new Error("Expected a serialized import body");
        importedPayloads.push(JSON.parse(init.body) as unknown);
        return Promise.resolve(new Response(JSON.stringify(project), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const body = url === "/api/runtime" ? runtime : url === "/api/settings/providers" ? providerSettings : project;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
    render(<App />);
    await screen.findByText("auth-repository");

    const secret = new File(["SECRET=never-read"], ".env", { type: "text/plain" });
    const source = new File(["export const safe = true;"], "index.ts", { type: "text/plain" });
    const readSecret = vi.fn(() => Promise.resolve("SECRET=never-read"));
    const readSource = vi.fn(() => Promise.resolve("export const safe = true;"));
    Object.defineProperties(secret, {
      webkitRelativePath: { value: "portfolio/.env" },
      text: { value: readSecret },
    });
    Object.defineProperties(source, {
      webkitRelativePath: { value: "portfolio/src/index.ts" },
      text: { value: readSource },
    });

    fireEvent.change(screen.getByLabelText("Repository folder"), { target: { files: [secret, source] } });

    await waitFor(() => expect(importedPayloads).toHaveLength(1));
    expect(readSecret).not.toHaveBeenCalled();
    expect(readSource).toHaveBeenCalledOnce();
    expect(importedPayloads[0]).toEqual({
      name: "portfolio",
      files: [{ path: "src/index.ts", content: "export const safe = true;" }],
    });
  });

  it("shows the locked OpenCode Zen Free profile without exposing a key field", async () => {
    mockFetch(freeProviderSettings);
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: /Settings/ }));

    expect(await screen.findByRole("heading", { name: "Free Mode" })).toBeTruthy();
    expect(screen.getAllByText("OpenCode Zen").length).toBeGreaterThan(0);
    expect(screen.getByText("DeepSeek V4 Flash Free")).toBeTruthy();
    expect(screen.getByText(/server-owned Free credential is locked/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Your API key/i)).toBeNull();
  });

  it("loads account models with autocomplete and applies a ready-made profile to every role", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
      if (url === "/api/settings/provider-models") {
        if (typeof init?.body !== "string") throw new Error("Expected a serialized model catalog request");
        const request = JSON.parse(init.body) as { connectionId: string };
        const catalog: ProviderModelsView = {
          provider: "openai",
          models: [
            { id: "gpt-5", name: "GPT 5" },
            { id: "gpt-5-mini", name: "GPT 5 Mini" },
            { id: "gpt-5-codex", name: "GPT 5 Codex" },
          ],
          profiles: [{
            id: "balanced",
            name: "Balanced",
            description: "Fast for routine work and stronger for decisions.",
            defaultModel: "gpt-5-mini",
            assignments: providerRoles.map((role) => ({
              role,
              connectionId: request.connectionId,
              model: role === "implementer" ? "gpt-5-codex" : role === "investigator" || role === "reviewer" ? "gpt-5-mini" : "gpt-5",
            })),
          }],
        };
        return Promise.resolve(new Response(JSON.stringify(catalog), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      const body = url === "/api/runtime" ? runtime : url === "/api/settings/providers" ? providerSettings : project;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: /Settings/ }));
    fireEvent.click(await screen.findByRole("button", { name: "+ New provider set" }));

    const key = screen.getByLabelText("OpenAI personal API key");
    fireEvent.change(key, { target: { value: "sk-personal-test" } });
    fireEvent.blur(key);

    expect(await screen.findByText("3 models loaded. Choose a profile or search by name.")).toBeTruthy();
    const profile = await screen.findByRole("button", { name: /Balanced/ });
    expect(screen.getByLabelText("OpenAI model").getAttribute("list")).toMatch(/^model-list-provider-/);
    fireEvent.click(profile);
    fireEvent.click(screen.getByText("Advanced routing"));

    expect(screen.getByLabelText<HTMLInputElement>("implementer model").value).toBe("gpt-5-codex");
    expect(screen.getByLabelText<HTMLInputElement>("judge model").value).toBe("gpt-5");
    expect(screen.getByLabelText<HTMLInputElement>("reviewer model").value).toBe("gpt-5-mini");
  });

  it("shows model loading failures beside the button instead of failing invisibly", async () => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url === "/api/settings/provider-models") {
        return Promise.resolve(new Response(JSON.stringify({ error: { message: "Method not allowed." } }), { status: 405, headers: { "Content-Type": "application/json" } }));
      }
      const body = url === "/api/runtime" ? runtime : url === "/api/settings/providers" ? providerSettings : project;
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    }));
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: /Settings/ }));
    fireEvent.click(await screen.findByRole("button", { name: "+ New provider set" }));
    fireEvent.change(screen.getByLabelText("OpenAI personal API key"), { target: { value: "sk-personal-test" } });
    fireEvent.click(screen.getByRole("button", { name: "Load models" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Model loading is not active in the running local server. Restart Conclave, then try again.");
    expect(screen.getByRole("button", { name: "Load models" }).hasAttribute("disabled")).toBe(false);
  });
});
