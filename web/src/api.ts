import type { GraphView, ProductRunView, ProjectView, RuntimeModeView } from "../../src/web/contracts.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = payload as { error?: { message?: string } };
    throw new Error(error.error?.message ?? "Conclave request failed.");
  }
  return payload as T;
}

function json(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

export const api = {
  runtime: (): Promise<RuntimeModeView> => request("/api/runtime"),
  demo: (): Promise<ProjectView> => request("/api/projects/demo", json({})),
  open: (path: string): Promise<ProjectView> => request("/api/projects/open", json({ path })),
  run: (projectId: string, intent: "ask" | "investigate", query: string): Promise<ProductRunView> => request("/api/run", json({ projectId, intent, query })),
  task: (projectId: string, objective: string, planOnly: boolean, permissions: object): Promise<ProductRunView> => request("/api/task", json({ projectId, objective, planOnly, permissions })),
  graph: (projectId: string, symbol: string): Promise<GraphView> => request(`/api/graph?projectId=${encodeURIComponent(projectId)}&symbol=${encodeURIComponent(symbol)}`),
};
