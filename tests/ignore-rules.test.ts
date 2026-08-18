import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createRepositoryIgnore, DEFAULT_IGNORE_PATTERNS } from "../src/repositories/ignore-rules.js";

async function fixture(files: Readonly<Record<string, string>> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-ignore-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content);
  }
  return root;
}

describe("repository ignore rules", () => {
  it("keeps secrets and build output out of the index without any repository config", async () => {
    const matcher = await createRepositoryIgnore(await fixture());
    for (const path of [
      ".git/config",
      "node_modules/left-pad/index.js",
      "dist/cli.js",
      "coverage/index.html",
      ".conclave/index.json",
      "vendor/bundle.min.js",
      "app.js.map",
      ".env",
      ".env.local",
      "server.pem",
      "deploy.key",
      "id_rsa",
      "id_ed25519.pub",
      "credentials.json",
      "secrets.production.json",
    ]) {
      expect(matcher.ignores(path), `${path} must be ignored by default`).toBe(true);
    }
  });

  it("still indexes ordinary source and the committed environment example", async () => {
    const matcher = await createRepositoryIgnore(await fixture());
    for (const path of ["src/index.ts", "README.md", "tests/app.test.ts", ".env.example"]) {
      expect(matcher.ignores(path), `${path} must remain indexable`).toBe(false);
    }
  });

  it("applies .gitignore on top of the defaults", async () => {
    const root = await fixture({ ".gitignore": "generated/\n*.snapshot\n" });
    const matcher = await createRepositoryIgnore(root);
    expect(matcher.ignores("generated/schema.ts")).toBe(true);
    expect(matcher.ignores("tests/ui.snapshot")).toBe(true);
    expect(matcher.ignores("src/index.ts")).toBe(false);
  });

  it("lets .conclaveignore narrow the index further than Git does", async () => {
    const root = await fixture({ ".conclaveignore": "docs/\nfixtures/**/*.ts\n" });
    const matcher = await createRepositoryIgnore(root);
    expect(matcher.ignores("docs/architecture.md")).toBe(true);
    expect(matcher.ignores("fixtures/sample/app.ts")).toBe(true);
    expect(matcher.ignores("src/index.ts")).toBe(false);
  });

  it("reads both ignore files when a repository ships them together", async () => {
    const root = await fixture({ ".gitignore": "from-git/\n", ".conclaveignore": "from-conclave/\n" });
    const matcher = await createRepositoryIgnore(root);
    expect(matcher.ignores("from-git/a.ts")).toBe(true);
    expect(matcher.ignores("from-conclave/b.ts")).toBe(true);
  });

  it("surfaces an unreadable ignore path instead of silently indexing everything", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-ignore-unreadable-"));
    // A directory where a file is expected fails with EISDIR, not ENOENT.
    await mkdir(join(root, ".gitignore"));
    await expect(createRepositoryIgnore(root)).rejects.toThrow();
  });

  it("treats a missing repository root as an empty ignore configuration", async () => {
    const matcher = await createRepositoryIgnore(join(tmpdir(), "conclave-ignore-absent-root"));
    expect(matcher.ignores("src/index.ts")).toBe(false);
    expect(matcher.ignores("node_modules/pkg/index.js")).toBe(true);
  });

  it("exposes the default patterns so callers can report what was excluded", () => {
    expect(DEFAULT_IGNORE_PATTERNS).toContain("node_modules/");
    expect(DEFAULT_IGNORE_PATTERNS).toContain("!.env.example");
  });
});
