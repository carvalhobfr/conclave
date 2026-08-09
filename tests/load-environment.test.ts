import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadLocalEnvironment } from "../src/config/load-environment.js";

describe("local .env loading", () => {
  it("uses .env as a fallback while preserving process-owned values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "conclave-env-test-"));
    const path = join(directory, ".env");
    const environment: NodeJS.ProcessEnv = { CONCLAVE_MODE: "api" };
    try {
      await writeFile(path, "# local fallback\nCONCLAVE_MODE=free\nCONCLAVE_FREE_API_KEY='server key'\nCONCLAVE_FREE_MODEL=deepseek-v4-flash-free # comment\n", "utf8");
      await loadLocalEnvironment(path, environment);
      expect(environment).toMatchObject({
        CONCLAVE_MODE: "api",
        CONCLAVE_FREE_API_KEY: "server key",
        CONCLAVE_FREE_MODEL: "deepseek-v4-flash-free",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
