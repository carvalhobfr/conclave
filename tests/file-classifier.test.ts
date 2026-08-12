import { describe, expect, it } from "vitest";

import { detectLanguage, isLikelyBinary } from "../src/repositories/file-classifier.js";

describe("file classifier", () => {
  it.each([
    ["src/App.tsx", "tsx"],
    ["src/index.ts", "typescript"],
    ["scripts/build.mjs", "javascript"],
    ["src/auth/session.py", "python"],
    ["src/auth/Session.java", "java"],
    ["README.md", "markdown"],
    ["Dockerfile", "unknown"],
  ] as const)("detects %s as %s", (path, expected) => {
    expect(detectLanguage(path)).toBe(expected);
  });

  it("detects binary content without treating normal source as binary", () => {
    expect(isLikelyBinary("asset.data", Buffer.from([1, 0, 2]))).toBe(true);
    expect(isLikelyBinary("src/index.ts", Buffer.from("export const value = 1;\n"))).toBe(false);
    expect(isLikelyBinary("image.png", Buffer.from("not really a png"))).toBe(true);
  });
});
