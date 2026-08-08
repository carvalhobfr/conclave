import { describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { loadTaskConfiguration } from "../src/config/task-config.js";

describe("task configuration", () => {
  it("keeps execution roles independent from provider and model selection", () => {
    const environment = {
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "openai",
      CONCLAVE_MODEL: "default-model",
      CONCLAVE_BASE_URL: "https://api.example/v1",
      CONCLAVE_IMPLEMENTER_PROVIDER: "openrouter",
      CONCLAVE_IMPLEMENTER_MODEL: "implementation-model",
      CONCLAVE_ALLOWED_PACKAGE_SCRIPTS: "test,typecheck",
    };
    const config = loadTaskConfiguration(loadRuntimeConfig(environment), environment);

    expect(config.assignments.find((assignment) => assignment.role === "planner")).toEqual(
      expect.objectContaining({ providerId: "openai", modelId: "default-model" }),
    );
    expect(config.assignments.find((assignment) => assignment.role === "implementer")).toEqual(
      expect.objectContaining({ providerId: "openrouter", modelId: "implementation-model" }),
    );
    expect(config.allowedPackageScripts).toEqual(["test", "typecheck"]);
  });

  it("rejects shell-shaped package script names", () => {
    const environment = {
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "openai",
      CONCLAVE_MODEL: "model",
      CONCLAVE_BASE_URL: "https://api.example/v1",
      CONCLAVE_ALLOWED_PACKAGE_SCRIPTS: "test; curl evil.test",
    };

    expect(() => loadTaskConfiguration(loadRuntimeConfig(environment), environment)).toThrow(
      "Invalid allowed package script",
    );
  });
});
