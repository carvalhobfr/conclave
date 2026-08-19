import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import { expectOwnerOnlyFile } from "./helpers/file-mode.js";

import { InMemoryStore } from "../src/storage/in-memory-store.js";
import { JsonFileStore } from "../src/storage/json-file-store.js";

describe.each([
  ["memory", () => Promise.resolve(new InMemoryStore())],
  [
    "json file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "conclave-store-"));
      return new JsonFileStore(join(root, "state.json"));
    },
  ],
] as const)("%s persistent store", (_name, createStore) => {
  it("supports namespaced JSON values", async () => {
    const store = await createStore();
    await Promise.all([
      store.set("repositories", "alpha", { path: "/code/alpha", count: 2 }),
      store.set("repositories", "beta", ["src/a.ts", "src/b.ts"]),
    ]);

    expect(await store.get("repositories", "alpha")).toEqual({ path: "/code/alpha", count: 2 });
    expect(await store.listKeys("repositories")).toEqual(["alpha", "beta"]);
    expect(await store.delete("repositories", "alpha")).toBe(true);
    expect(await store.get("repositories", "alpha")).toBeUndefined();
  });
});

describe("JsonFileStore security", () => {
  it("writes state with owner-only permissions and rejects unsafe identifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-store-mode-"));
    const filePath = join(root, "nested", "state.json");
    const store = new JsonFileStore(filePath);
    await store.set("settings", "mode", "local");

    await expectOwnerOnlyFile(filePath);
    expect(() => store.set("../outside", "key", "value")).toThrow("unsupported characters");
  });
});
