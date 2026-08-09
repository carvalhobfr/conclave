import { describe, expect, it } from "vitest";

import { isSensitiveRepositoryPath } from "../src/security/sensitive-repository-path.js";

describe("isSensitiveRepositoryPath", () => {
  it("blocks environment and credential files case-insensitively", () => {
    expect(isSensitiveRepositoryPath(".env")).toBe(true);
    expect(isSensitiveRepositoryPath("config/.ENV.LOCAL")).toBe(true);
    expect(isSensitiveRepositoryPath("keys/service.pem")).toBe(true);
    expect(isSensitiveRepositoryPath("id_ed25519.pub")).toBe(true);
    expect(isSensitiveRepositoryPath("config/credentials.prod.json")).toBe(true);
  });

  it("allows the documented environment template", () => {
    expect(isSensitiveRepositoryPath(".env.example")).toBe(false);
    expect(isSensitiveRepositoryPath("src/environment.ts")).toBe(false);
  });
});
