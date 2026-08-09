import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadLocalEnvironment } from "../config/load-environment.js";
import { loadReasoningConfiguration } from "../config/reasoning-config.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { loadTaskConfiguration } from "../config/task-config.js";
import { diagnoseProvider } from "../providers/provider-diagnostics.js";
import { EnvironmentCredentialSource } from "../storage/environment-credential-source.js";
import { ConclaveProductService } from "../web/product-service.js";

await loadLocalEnvironment();

const freeKey = process.env["CONCLAVE_FREE_API_KEY"]?.trim();
if (freeKey === undefined || freeKey === "") {
  console.log("Zen smoke skipped: CONCLAVE_FREE_API_KEY is not configured.");
  process.exit(0);
}

const environment: NodeJS.ProcessEnv = { ...process.env, CONCLAVE_MODE: "free" };
const credentials = new EnvironmentCredentialSource(environment);
const runtime = loadRuntimeConfig(environment);
const reasoning = loadReasoningConfiguration(runtime, environment);
const task = loadTaskConfiguration(runtime, environment);
const diagnostics = await diagnoseProvider(runtime, credentials, {
  assignments: [...reasoning.assignments, ...task.assignments],
});

if (!diagnostics.inferenceAvailable) {
  throw new Error(`Zen bounded inference diagnostic failed: ${diagnostics.message}`);
}

let fullReasoning: { readonly ask: string; readonly investigate: string } | "not-requested" = "not-requested";
if (process.env["CONCLAVE_ZEN_FULL_SMOKE"] === "1") {
  const repositoryRoot = resolve("tests/fixtures/code-rag");
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "conclave-zen-smoke-"));
  try {
    const product = new ConclaveProductService({
      allowedRoot: repositoryRoot,
      environment,
      settingsFile: join(temporaryDirectory, "settings.json"),
    });
    const project = await product.openLocal(repositoryRoot);
    const ask = await product.run(project.id, "ask", "Where is bootstrapSession called?");
    const investigate = await product.run(project.id, "investigate", "Why might authentication disappear after refresh?");
    for (const [label, result] of [["ask", ask], ["investigate", investigate]] as const) {
      if (result.status === "error" || result.status === "failed") {
        throw new Error(`Zen full reasoning smoke failed for ${label}: ${result.error?.message ?? "no accepted verdict"}`);
      }
      const evidenceIds = new Set(result.evidence.map((evidence) => evidence.id));
      if (result.claims.some((claim) => claim.evidenceIds.some((id) => !evidenceIds.has(id)))) {
        throw new Error("Zen full reasoning smoke returned a claim with invalid evidence provenance.");
      }
    }
    fullReasoning = { ask: ask.status, investigate: investigate.status };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({ diagnostics, fullReasoning }, undefined, 2));
