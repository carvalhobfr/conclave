import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ProviderRole, ProviderSetInput } from "../src/web/contracts.js";
import { ProviderSettingsStore } from "../src/web/provider-settings.js";

const temporaryDirectories: string[] = [];
const roles: readonly ProviderRole[] = ["investigator", "skeptic", "architect", "verifier", "judge", "planner", "implementer", "reviewer"];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store(): Promise<ProviderSettingsStore> {
  const directory = await mkdtemp(join(tmpdir(), "conclave-provider-settings-test-"));
  temporaryDirectories.push(directory);
  return new ProviderSettingsStore({
    filePath: join(directory, "settings.json"),
    environment: {
      CONCLAVE_MODE: "free",
      CONCLAVE_FREE_PROVIDER: "openai",
      CONCLAVE_FREE_MODEL: "fixed-test-model",
      CONCLAVE_FREE_MODEL_ALLOWLIST: "fixed-test-model,deepseek-v4-flash-free,nemotron-3-ultra-free,north-mini-code-free",
      CONCLAVE_FREE_API_KEY: "server-test-key",
    },
  });
}

function personalSet(id = "personal-1"): ProviderSetInput {
  return {
    id,
    name: "My providers",
    providers: [{ id: "openai-main", provider: "openai", model: "gpt-5-mini", baseUrl: "https://api.openai.com/v1", apiKey: "user-owned-secret" }],
    roles: roles.map((role) => ({ role, connectionId: "openai-main", model: "gpt-5-mini" })),
  };
}

describe("ProviderSettingsStore", () => {
  it("keeps the free environment model locked and never returns personal keys", async () => {
    const settings = await store();
    const saved = await settings.save({ activeSetId: "personal-1", sets: [personalSet()] });

    expect(saved.environment).toMatchObject({ label: "Free Mode", provider: "OpenCode Zen", model: "Fixed Test Model", locked: true });
    expect(saved.environment.roles).toHaveLength(8);
    expect(saved.activeSetId).toBe("personal-1");
    expect(saved.sets[0]?.providers[0]?.apiKeyConfigured).toBe(true);
    expect(JSON.stringify(saved)).not.toContain("user-owned-secret");

    const retained = await settings.save({
      activeSetId: "personal-1",
      sets: [{ ...personalSet(), providers: [{ ...personalSet().providers[0]!, apiKey: "" }] }],
    });
    expect(retained.sets[0]?.providers[0]?.apiKeyConfigured).toBe(true);
  });

  it("rejects more than five personal provider sets", async () => {
    const settings = await store();
    await expect(settings.save({ sets: Array.from({ length: 6 }, (_, index) => personalSet(`personal-${String(index)}`)) })).rejects.toThrow(/up to 5 provider sets/i);
  });
});
