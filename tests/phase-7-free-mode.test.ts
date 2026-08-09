import { describe, expect, it, vi } from "vitest";

import { loadReasoningConfiguration } from "../src/config/reasoning-config.js";
import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { loadTaskConfiguration } from "../src/config/task-config.js";
import { FreeUsageController, InMemoryUsageGate } from "../src/hosted/free-usage-controller.js";
import { diagnoseProvider } from "../src/providers/provider-diagnostics.js";
import { createProviderRuntime } from "../src/providers/provider-runtime.js";
import { EnvironmentCredentialSource } from "../src/storage/environment-credential-source.js";

const freeEnvironment = {
  CONCLAVE_MODE: "free",
  CONCLAVE_FREE_API_KEY: "server-owned-test-secret",
};

function completion(): Response {
  return new Response(JSON.stringify({ model: "diagnostic-model", choices: [{ message: { content: "OK" } }] }), { status: 200 });
}

describe("Phase 7 Free Mode", () => {
  it("uses the exact Zen endpoint, model IDs, and full reasoning/task ensemble by default", () => {
    const runtime = loadRuntimeConfig(freeEnvironment);
    if (runtime.mode !== "free") throw new Error("Expected Free Mode");
    const reasoning = loadReasoningConfiguration(runtime, freeEnvironment);
    const task = loadTaskConfiguration(runtime, freeEnvironment);

    expect(runtime.providerSelection).toEqual({
      provider: "openai",
      model: "deepseek-v4-flash-free",
      baseUrl: "https://opencode.ai/zen/v1",
    });
    expect(runtime.allowedModels).toEqual([
      "deepseek-v4-flash-free",
      "nemotron-3-ultra-free",
      "north-mini-code-free",
    ]);
    expect(Object.fromEntries(reasoning.assignments.map((assignment) => [assignment.role, assignment.modelId]))).toEqual({
      investigator: "deepseek-v4-flash-free",
      skeptic: "nemotron-3-ultra-free",
      architect: "nemotron-3-ultra-free",
      verifier: "deepseek-v4-flash-free",
      judge: "nemotron-3-ultra-free",
    });
    expect(Object.fromEntries(task.assignments.map((assignment) => [assignment.role, assignment.modelId]))).toEqual({
      planner: "nemotron-3-ultra-free",
      implementer: "north-mini-code-free",
      reviewer: "deepseek-v4-flash-free",
    });
  });

  it("keeps Free, API, and Local provider settings isolated", () => {
    const free = loadRuntimeConfig({
      ...freeEnvironment,
      CONCLAVE_PROVIDER: "openrouter",
      CONCLAVE_BASE_URL: "https://api-mode.invalid/v1",
      CONCLAVE_MODEL: "api-only-model",
    });
    const api = loadRuntimeConfig({
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "openrouter",
      CONCLAVE_BASE_URL: "https://openrouter.example/v1",
      CONCLAVE_MODEL: "api-model",
      CONCLAVE_FREE_BASE_URL: "https://free-mode.invalid/v1",
      CONCLAVE_FREE_MODEL: "deepseek-v4-flash-free",
    });
    const local = loadRuntimeConfig({
      CONCLAVE_MODE: "local",
      CONCLAVE_PROVIDER: "ollama",
      CONCLAVE_MODEL: "local-model",
      CONCLAVE_FREE_BASE_URL: "https://free-mode.invalid/v1",
    });

    expect(free.providerSelection).toMatchObject({ provider: "openai", baseUrl: "https://opencode.ai/zen/v1", model: "deepseek-v4-flash-free" });
    expect(api.providerSelection).toEqual({ provider: "openrouter", baseUrl: "https://openrouter.example/v1", model: "api-model" });
    expect(local.providerSelection).toEqual({ provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "local-model" });
  });

  it("rejects role model overrides outside the host Free allowlist", () => {
    const environment = { ...freeEnvironment, CONCLAVE_SKEPTIC_MODEL: "paid-or-unknown-model" };
    const runtime = loadRuntimeConfig(environment);
    expect(() => loadReasoningConfiguration(runtime, environment)).toThrow("host-controlled allowlist");
  });

  it("fails clearly when the server-owned Free credential is missing", () => {
    const runtime = loadRuntimeConfig({ CONCLAVE_MODE: "free" });
    const assignments = loadReasoningConfiguration(runtime, { CONCLAVE_MODE: "free" }).assignments;
    expect(() => createProviderRuntime(runtime, new EnvironmentCredentialSource({}), assignments)).toThrow("CONCLAVE_FREE_API_KEY is required");
  });

  it("makes role provider IDs inherit the Zen endpoint and one server-owned credential", async () => {
    const environment = { ...freeEnvironment, CONCLAVE_SKEPTIC_PROVIDER: "openrouter" };
    const runtime = loadRuntimeConfig(environment);
    const assignments = loadReasoningConfiguration(runtime, environment).assignments;
    const fetchImplementation = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      expect(input).toEqual(new URL("https://opencode.ai/zen/v1/chat/completions"));
      expect(init?.headers).toEqual(expect.objectContaining({ authorization: "Bearer server-owned-test-secret" }));
      return Promise.resolve(completion());
    });
    const providers = createProviderRuntime(runtime, new EnvironmentCredentialSource(environment), assignments, { fetchImplementation });

    await providers.get("openrouter")?.generate({
      model: "nemotron-3-ultra-free",
      messages: [{ role: "user", content: "inheritance check" }],
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
    expect(JSON.stringify({ runtime, assignments, providers })).not.toContain("server-owned-test-secret");
  });

  it("reports safe bounded diagnostics with endpoint, exact model, and all effective roles", async () => {
    const runtime = loadRuntimeConfig(freeEnvironment);
    const assignments = [
      ...loadReasoningConfiguration(runtime, freeEnvironment).assignments,
      ...loadTaskConfiguration(runtime, freeEnvironment).assignments,
    ];
    const diagnostics = await diagnoseProvider(runtime, new EnvironmentCredentialSource(freeEnvironment), {
      assignments,
      fetchImplementation: () => Promise.resolve(completion()),
    });

    expect(diagnostics).toMatchObject({
      endpoint: "https://opencode.ai/zen/v1",
      endpointHost: "opencode.ai",
      model: "deepseek-v4-flash-free",
      inferenceAvailable: true,
    });
    expect(diagnostics.assignments).toHaveLength(8);
    expect(diagnostics.assignments).toContainEqual({ role: "implementer", provider: "openai", model: "north-mini-code-free" });
    expect(JSON.stringify(diagnostics)).not.toContain("server-owned-test-secret");
  });
});

describe("hosted Free foundation", () => {
  it("enforces model allowlisting and per-client quota windows", async () => {
    let now = 0;
    const controller = new FreeUsageController({
      allowedModels: ["free-model"],
      gate: new InMemoryUsageGate({ quota: 1, windowMs: 100, now: () => now }),
      maxConcurrency: 1,
    });
    const request = { clientId: "client-a", operation: "ask" as const, models: ["free-model"] };

    await expect(controller.run(request, () => Promise.resolve("ok"))).resolves.toBe("ok");
    await expect(controller.run(request, () => Promise.resolve("unexpected"))).rejects.toMatchObject({ code: "quota_exhausted" });
    await expect(controller.run({ ...request, models: ["not-free"] }, () => Promise.resolve("unexpected"))).rejects.toMatchObject({ code: "model_not_allowed" });
    now = 100;
    await expect(controller.run(request, () => Promise.resolve("next-window"))).resolves.toBe("next-window");
  });

  it("reserves concurrency before awaiting an asynchronous usage gate", async () => {
    let releaseAuthorization: (() => void) | undefined;
    const authorization = new Promise<void>((resolve) => { releaseAuthorization = resolve; });
    const controller = new FreeUsageController({
      allowedModels: ["free-model"],
      gate: { authorize: async () => { await authorization; return { allowed: true, reason: "authorized", remaining: 1 }; } },
      maxConcurrency: 1,
    });
    const first = controller.run({ clientId: "a", operation: "ask", models: ["free-model"] }, () => Promise.resolve("first"));

    await expect(controller.run({ clientId: "b", operation: "investigate", models: ["free-model"] }, () => Promise.resolve("second"))).rejects.toMatchObject({ code: "concurrency_limit" });
    releaseAuthorization?.();
    await expect(first).resolves.toBe("first");
  });
});
