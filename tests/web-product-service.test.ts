import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { ProviderRole } from "../src/web/contracts.js";
import { ConclaveProductService } from "../src/web/product-service.js";
import { ProviderModelCatalog } from "../src/web/provider-model-catalog.js";
import { FreeUsageController } from "../src/hosted/free-usage-controller.js";

const demoRoot = resolve("demo/auth-repository");
const providerRoles: readonly ProviderRole[] = ["investigator", "skeptic", "architect", "verifier", "judge", "planner", "implementer", "reviewer"];

function service(): ConclaveProductService {
  return new ConclaveProductService({ demoRoot, allowedRoot: resolve("demo") });
}

describe("ConclaveProductService", () => {
  it("runs deterministic Ask and exposes graph-backed evidence", async () => {
    const product = service();
    const project = await product.openDemo();
    const run = await product.run(project.id, "ask", "Where is bootstrapSession called?");

    expect(run.status).toBe("completed");
    expect(run.trace.find((item) => item.role === "skeptic")?.status).toBe("skipped");
    expect(run.evidence[0]).toEqual(expect.objectContaining({ path: "src/auth/AuthProvider.ts" }));
    expect(run.graph.status).toBe("resolved");
    expect(run.retrieval.approximateTokens).toBeGreaterThan(0);
  });

  it("reports bounded operational progress while an Ask run is active", async () => {
    const product = service();
    const project = await product.openDemo();
    const started = product.startRun(project.id, "ask", "Where is bootstrapSession called?");

    expect(started.status).toBe("running");
    let completed = product.runStatus(started.id);
    for (let attempt = 0; completed.status === "running" && attempt < 20; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = product.runStatus(started.id);
    }

    expect(completed.status).toBe("completed");
    expect(completed.result?.status).toBe("completed");
    expect(completed.progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "Reading existing Project Knowledge" }),
      expect.objectContaining({ stage: "Resolved from static repository knowledge" }),
      expect.objectContaining({ stage: "Evidence is sufficient; stopping early" }),
      expect.objectContaining({ stage: "Verdict completed" }),
    ]));
    expect(completed.result?.metrics).toContainEqual({ label: "Model calls", value: "0" });
  });

  it("keeps rejected hypotheses visible for Investigate", async () => {
    const product = service();
    const project = await product.openDemo();
    const run = await product.run(project.id, "investigate", "Why might authentication disappear after refresh?");

    expect(run.claims).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "rejected", statement: "The token is never persisted." })]),
    );
    expect(run.trace.every((item) => item.status === "ran")).toBe(true);
  });

  it("returns a plan-only task with default-deny permissions", async () => {
    const product = service();
    const project = await product.openDemo();
    const run = await product.task(
      project.id,
      "Fix authentication disappearing after refresh.",
      true,
      { allowFileEdits: false, allowCommands: false, allowRepositoryScripts: false, allowNetwork: false },
    );

    expect(run.status).toBe("planned");
    expect(run.task?.permissions.allowFileEdits).toBe(false);
    expect(run.task?.diff).toHaveLength(0);
  });

  it("runs Task through the same cancellable browser job protocol", async () => {
    const product = service();
    const project = await product.openDemo();
    const started = product.startTask(
      project.id,
      "Fix authentication disappearing after refresh.",
      true,
      { allowFileEdits: false, allowCommands: false, allowRepositoryScripts: false, allowNetwork: false },
    );

    expect(started).toMatchObject({ intent: "task", status: "running" });
    let completed = product.runStatus(started.id);
    for (let attempt = 0; completed.status !== "completed" && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = product.runStatus(started.id);
    }
    expect(completed.result).toMatchObject({ intent: "task", status: "planned" });
    expect(completed.progress).toEqual(expect.arrayContaining([
      expect.objectContaining({ stage: "Reading Project Knowledge for the task" }),
      expect.objectContaining({ stage: "Verified change plan prepared" }),
      expect.objectContaining({ stage: "Task verdict completed" }),
    ]));
    expect(completed.snapshot?.evidence.length).toBeGreaterThan(0);
  });

  it("runs the bounded demo task in isolation and returns only the final patch", async () => {
    const product = service();
    const project = await product.openDemo();
    const run = await product.task(
      project.id,
      "Fix authentication disappearing after refresh.",
      false,
      { allowFileEdits: true, allowCommands: false, allowRepositoryScripts: false, allowNetwork: false },
    );

    expect(run.status).toBe("completed");
    expect(run.claims.some((claim) => claim.status === "rejected")).toBe(true);
    expect(run.task?.revisionRounds).toBe(1);
    expect(run.task?.diff).toHaveLength(1);
    expect(run.task?.diff[0]?.patch).toContain("const persistedToken = getStoredToken();");
  });

  it("retains completed-with-uncertainty instead of prettifying it", async () => {
    const product = service();
    const project = await product.openDemo();
    const run = await product.task(
      project.id,
      "Fix authentication disappearing after refresh. Keep runtime behavior uncertain.",
      false,
      { allowFileEdits: true, allowCommands: false, allowRepositoryScripts: false, allowNetwork: false },
    );

    expect(run.status).toBe("completed-with-uncertainty");
  });

  it("exposes deterministic Review semantics without a parallel reviewer pipeline", async () => {
    const product = service();
    const project = await product.openDemo();
    const empty = await product.review(project.id, { kind: "explicit", label: "empty" }, "", "Review implementation");
    const documentation = await product.review(project.id, { kind: "explicit", label: "docs" }, [
      "diff --git a/docs/usage.md b/docs/usage.md",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/docs/usage.md",
      "@@ -0,0 +1,1 @@",
      "+# Usage",
    ].join("\n"), "Document usage");

    expect(empty.status).toBe("nothing-to-review");
    expect(empty.metrics).toContainEqual({ label: "Model calls", value: "0" });
    expect(documentation.status).toBe("approved");
    expect(documentation.analysis.route).toBe("project-knowledge");
  });

  it("exposes claim-based Decision Validation with implementation handoff", async () => {
    const product = service();
    const project = await product.openDemo();
    const verdict = await product.decide(project.id, "- bootstrapSession exists", "Reuse the existing bootstrap flow");

    expect(verdict.status).toBe("proceed");
    expect(verdict.claims).toContainEqual(expect.objectContaining({ statement: "bootstrapSession exists", status: "supported", deterministic: true }));
    expect(verdict.metrics).toContainEqual({ label: "Model calls", value: "0" });
    expect(verdict.implementationHandoff).toContain("Reuse the existing bootstrap flow");
  });

  it("refuses local paths outside the server configured root", async () => {
    await expect(service().openLocal(resolve("."))).rejects.toMatchObject({ code: "repository_denied" });
  });

  it("imports a repository selected by a browser folder picker", async () => {
    const project = await service().importLocal("phone-project", [
      { path: "src/index.ts", content: "export function selectedFromDevice(): string { return 'ready'; }\n" },
      { path: "package.json", content: "{\"name\":\"phone-project\"}\n" },
    ]);

    expect(project).toMatchObject({ name: "phone-project", source: "local" });
    expect(project.indexedFiles).toBeGreaterThan(0);
  });

  it("drops sensitive files before materializing a browser repository import", async () => {
    const product = service();
    const project = await product.importLocal("safe-import", [
      { path: ".env", content: "SECRET=must-not-be-materialized\n" },
      { path: ".ENV.LOCAL", content: "TOKEN=must-not-be-materialized\n" },
      { path: "keys/service.pem", content: "private-key-material\n" },
      { path: ".env.example", content: "SECRET=\n" },
      { path: "src/index.ts", content: "export const safe = true;\n" },
    ]);

    expect(project.indexedFiles).toBeGreaterThan(0);
    await expect(product.importLocal("only-secrets", [
      { path: ".env", content: "SECRET=must-not-be-materialized\n" },
    ])).rejects.toMatchObject({ code: "invalid_repository_import" });
  });

  it("enforces the host Free usage gate before creating a live provider", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conclave-free-boundary-test-"));
    try {
      const product = new ConclaveProductService({
        settingsFile: join(directory, "settings.json"),
        environment: { CONCLAVE_MODE: "free" },
        freeUsageController: new FreeUsageController({
          allowedModels: ["deepseek-v4-flash-free", "nemotron-3-ultra-free", "north-mini-code-free"],
          gate: { authorize: () => Promise.resolve({ allowed: false, reason: "quota-exhausted", remaining: 0 }) },
          maxConcurrency: 1,
        }),
      });
      const project = await product.importLocal("quota-fixture", [
        { path: "src/index.ts", content: "export const ready = true;\n" },
      ]);
      const result = await product.run(project.id, "ask", "Is this repository ready?");

      expect(result.status).toBe("error");
      expect(result.error?.code).toBe("quota_exhausted");
      expect(result.error?.message).not.toContain("CONCLAVE_FREE_API_KEY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses only the saved personal key for model discovery without returning it", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conclave-model-catalog-boundary-test-"));
    try {
      let requestedUrl = "";
      let requestedAuthorization: string | undefined;
      const fetcher = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        requestedUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
        requestedAuthorization = (init?.headers as Readonly<Record<string, string>> | undefined)?.["Authorization"];
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: "gpt-5-mini" }, { id: "gpt-5" }] }), { status: 200 }));
      });
      const product = new ConclaveProductService({
        settingsFile: join(directory, "settings.json"),
        environment: { CONCLAVE_MODE: "free", CONCLAVE_FREE_API_KEY: "host-key-must-not-be-used" },
        providerModelCatalog: new ProviderModelCatalog(fetcher),
      });
      await product.saveProviderSettings({
        activeSetId: "personal",
        sets: [{
          id: "personal",
          name: "Personal OpenAI",
          providers: [{ id: "openai-main", provider: "openai", model: "gpt-5-mini", apiKey: "saved-personal-key" }],
          roles: providerRoles.map((role) => ({ role, connectionId: "openai-main", model: "gpt-5-mini" })),
        }],
      });

      const catalog = await product.providerModels({ provider: "openai", setId: "personal", connectionId: "openai-main" });

      expect(fetcher).toHaveBeenCalledOnce();
      expect(requestedUrl).toBe("https://api.openai.com/v1/models");
      expect(requestedAuthorization).toBe("Bearer saved-personal-key");
      expect(JSON.stringify(catalog)).not.toContain("saved-personal-key");
      expect(JSON.stringify(catalog)).not.toContain("host-key-must-not-be-used");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
