import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ConclaveProductService } from "../src/web/product-service.js";

const demoRoot = resolve("demo/auth-repository");

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

  it("refuses local paths outside the server configured root", async () => {
    await expect(service().openLocal(resolve("."))).rejects.toMatchObject({ code: "repository_denied" });
  });
});
