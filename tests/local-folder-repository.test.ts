import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { RepositoryPathError } from "../src/security/path-policy.js";

async function fixtureRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "conclave-repository-"));
}

describe("LocalFolderRepository", () => {
  it("loads safe text files and applies built-in, git, and Conclave ignore rules", async () => {
    const root = await fixtureRoot();
    await Promise.all([
      mkdir(join(root, "src"), { recursive: true }),
      mkdir(join(root, "node_modules", "package"), { recursive: true }),
      mkdir(join(root, "dist"), { recursive: true }),
      mkdir(join(root, "private"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(root, ".gitignore"), "ignored.ts\n"),
      writeFile(join(root, ".conclaveignore"), "private/\n"),
      writeFile(join(root, ".env"), "SECRET=never-index-this\n"),
      writeFile(join(root, ".ENV.LOCAL"), "SECRET=also-never-index-this\n"),
      writeFile(join(root, ".env.example"), "SAFE_PLACEHOLDER=\n"),
      writeFile(join(root, "ignored.ts"), "export const ignored = true;\n"),
      writeFile(join(root, "node_modules", "package", "index.js"), "module.exports = {};\n"),
      writeFile(join(root, "dist", "bundle.js"), "built output\n"),
      writeFile(join(root, "private", "notes.md"), "private\n"),
      writeFile(join(root, "src", "auth.ts"), "export function restoreSession() { return null; }\n"),
      writeFile(
        join(root, "src", "credentials.ts"),
        'export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";\n',
      ),
      writeFile(join(root, "asset.dat"), Buffer.from([1, 0, 2])),
      writeFile(join(root, "large.txt"), "x".repeat(300)),
    ]);
    await symlink(join(root, "src", "auth.ts"), join(root, "linked-auth.ts"));

    const snapshot = await new LocalFolderRepository({ maxFileBytes: 200 }).load({ path: root });
    const paths = snapshot.files.map((file) => file.relativePath);

    expect(paths).toContain("src/auth.ts");
    expect(paths).toContain("src/credentials.ts");
    expect(paths).toContain(".env.example");
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain(".ENV.LOCAL");
    expect(paths).not.toContain("ignored.ts");
    expect(paths).not.toContain("node_modules/package/index.js");
    expect(paths).not.toContain("private/notes.md");
    expect(snapshot.files.find((file) => file.relativePath === "src/auth.ts")?.language).toBe(
      "typescript",
    );
    expect(
      snapshot.files.find((file) => file.relativePath === "src/credentials.ts")?.safety
        .externalTransmissionAllowed,
    ).toBe(false);
    expect(snapshot.stats.safetyBlockedFiles).toBe(1);
    expect(snapshot.stats.skippedBinaryFiles).toBe(1);
    expect(snapshot.stats.skippedOversizedFiles).toBe(1);
    expect(snapshot.stats.skippedSymlinks).toBe(1);
  });

  it("rejects repository paths outside configured roots", async () => {
    const allowed = await fixtureRoot();
    const outside = await fixtureRoot();
    const repository = new LocalFolderRepository({ allowedRoots: [allowed] });

    await expect(repository.load({ path: outside })).rejects.toBeInstanceOf(RepositoryPathError);
  });
});
