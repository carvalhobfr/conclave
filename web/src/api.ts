import type { GraphView, ImportedRepositoryFile, ProductAnalysisDepth, ProductRunJobView, ProductRunView, ProjectView, ProviderModelsInput, ProviderModelsView, ProviderSettingsView, RuntimeModeView, SaveProviderSettingsInput } from "../../src/web/contracts.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    if (response.status === 405 && path === "/api/settings/provider-models") {
      throw new Error("Model loading is not active in the running local server. Restart Conclave, then try again.");
    }
    const error = payload as { error?: { message?: string } };
    throw new Error(error.error?.message ?? "Conclave request failed.");
  }
  return payload as T;
}

function json(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

function putJson(value: unknown): RequestInit {
  return { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

export const api = {
  runtime: (): Promise<RuntimeModeView> => request("/api/runtime"),
  providerSettings: (): Promise<ProviderSettingsView> => request("/api/settings/providers"),
  providerModels: (input: ProviderModelsInput): Promise<ProviderModelsView> => request("/api/settings/provider-models", json(input)),
  saveProviderSettings: (settings: SaveProviderSettingsInput): Promise<ProviderSettingsView> => request("/api/settings/providers", putJson(settings)),
  demo: (): Promise<ProjectView> => request("/api/projects/demo", json({})),
  open: (path: string): Promise<ProjectView> => request("/api/projects/open", json({ path })),
  importFolder: (name: string, files: readonly ImportedRepositoryFile[]): Promise<ProjectView> => request("/api/projects/import", json({ name, files })),
  run: (projectId: string, intent: "ask" | "investigate", query: string, depth: ProductAnalysisDepth = "auto"): Promise<ProductRunView> => request("/api/run", json({ projectId, intent, query, depth })),
  startRun: (projectId: string, intent: "ask" | "investigate", query: string, depth: ProductAnalysisDepth = "auto"): Promise<ProductRunJobView> => request("/api/runs", json({ projectId, intent, query, depth })),
  runStatus: (id: string): Promise<ProductRunJobView> => request(`/api/runs/${encodeURIComponent(id)}`),
  cancelRun: (id: string): Promise<ProductRunJobView> => request(`/api/runs/${encodeURIComponent(id)}`, { method: "DELETE" }),
  task: (projectId: string, objective: string, planOnly: boolean, permissions: object, depth: ProductAnalysisDepth = "auto"): Promise<ProductRunView> => request("/api/task", json({ projectId, objective, planOnly, permissions, depth })),
  startTask: (projectId: string, objective: string, planOnly: boolean, permissions: object, depth: ProductAnalysisDepth = "auto"): Promise<ProductRunJobView> => request("/api/task/runs", json({ projectId, objective, planOnly, permissions, depth })),
  graph: (projectId: string, symbol: string): Promise<GraphView> => request(`/api/graph?projectId=${encodeURIComponent(projectId)}&symbol=${encodeURIComponent(symbol)}`),
};
