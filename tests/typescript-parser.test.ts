import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { RepositoryFile, SourceLanguage } from "../src/domain/repository.js";
import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";

function sourceFile(
  relativePath: string,
  language: SourceLanguage,
  content: string,
): RepositoryFile {
  return {
    relativePath,
    language,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
    sizeBytes: Buffer.byteLength(content),
    modifiedAt: "2026-01-01T00:00:00.000Z",
    safety: { externalTransmissionAllowed: true, findings: [] },
  };
}

describe("TypeScriptCodeParser", () => {
  const parser = new TypeScriptCodeParser();

  it("extracts TypeScript declarations, nested symbols, imports, exports, and exact lines", () => {
    const content = `import { getStoredToken } from "./storage";
export interface Session { token: string }
export async function bootstrapSession() {
  const token = getStoredToken();
  function normalizeToken(value: string) {
    return value.trim();
  }
  return token ? normalizeToken(token) : null;
}`;
    const parsed = parser.parse(sourceFile("src/auth/session.ts", "typescript", content));

    expect(parsed.imports).toEqual([
      {
        source: "./storage",
        line: 1,
        bindings: [
          { imported: "getStoredToken", local: "getStoredToken", kind: "named", typeOnly: false },
        ],
      },
    ]);
    expect(parsed.exports.map((entry) => entry.localName)).toEqual(["Session", "bootstrapSession"]);
    expect(parsed.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          symbol: "Session",
          symbolKind: "interface",
          startLine: 2,
          endLine: 2,
          exported: true,
        }),
        expect.objectContaining({
          symbol: "bootstrapSession",
          symbolKind: "function",
          startLine: 3,
          endLine: 9,
          async: true,
        }),
        expect.objectContaining({
          symbol: "normalizeToken",
          parentSymbol: "bootstrapSession",
          startLine: 5,
          endLine: 7,
        }),
      ]),
    );
    const bootstrap = parsed.units.find((unit) => unit.symbol === "bootstrapSession");
    expect(bootstrap?.sourceText).toBe(content.split("\n").slice(2).join("\n"));
    expect(bootstrap?.calls).toEqual(
      expect.arrayContaining([
        { name: "getStoredToken", line: 4 },
        { name: "normalizeToken", line: 8 },
      ]),
    );
  });

  it("classifies TSX/JSX components and hooks", () => {
    const tsx = parser.parse(
      sourceFile(
        "src/Player.tsx",
        "tsx",
        `export const usePlayer = () => ({ id: "one" });
export function PlayerPanel() {
  const player = usePlayer();
  return <section>{player.id}</section>;
}`,
      ),
    );
    const jsx = parser.parse(
      sourceFile("src/Badge.jsx", "jsx", "export const Badge = () => <span>ready</span>;"),
    );

    expect(tsx.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "usePlayer", symbolKind: "hook" }),
        expect.objectContaining({ symbol: "PlayerPanel", symbolKind: "react-component" }),
      ]),
    );
    expect(jsx.units).toContainEqual(
      expect.objectContaining({ symbol: "Badge", symbolKind: "react-component" }),
    );
  });

  it("extracts JavaScript require imports, classes, methods, and CommonJS exports", () => {
    const parsed = parser.parse(
      sourceFile(
        "src/player.js",
        "javascript",
        `const { subscribe } = require("./events");
class PlayerService {
  async start() {
    return subscribe();
  }
}
exports.PlayerService = PlayerService;`,
      ),
    );

    expect(parsed.imports[0]).toEqual(
      expect.objectContaining({
        source: "./events",
        bindings: [
          { imported: "subscribe", local: "subscribe", kind: "require", typeOnly: false },
        ],
      }),
    );
    expect(parsed.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbol: "PlayerService", symbolKind: "class" }),
        expect.objectContaining({ symbol: "start", symbolKind: "method", parentSymbol: "PlayerService", async: true }),
      ]),
    );
    expect(parsed.exports).toContainEqual(
      expect.objectContaining({ name: "PlayerService", kind: "commonjs" }),
    );
  });

  it("returns partial symbols and diagnostics for malformed source", () => {
    const parsed = parser.parse(
      sourceFile(
        "src/broken.ts",
        "typescript",
        "export function stillVisible() {\n  return true;\n\nexport const other = () => 1;",
      ),
    );

    expect(parsed.units.map((unit) => unit.symbol)).toContain("stillVisible");
    expect(parsed.diagnostics.length).toBeGreaterThan(0);
  });

  it("extracts simple extends and implements clauses without resolving them", () => {
    const parsed = parser.parse(
      sourceFile(
        "src/controller.ts",
        "typescript",
        `interface Reader {}
class Base {}
export class Controller extends Base implements Reader {}`,
      ),
    );

    expect(parsed.units.find((unit) => unit.symbol === "Controller")?.heritage).toEqual([
      { name: "Base", relation: "extends", line: 3 },
      { name: "Reader", relation: "implements", line: 3 },
    ]);
  });

  it("uses deterministic identities", () => {
    const file = sourceFile("src/a.ts", "typescript", "export const run = () => true;");
    const first = parser.parse(file).units[0];
    const second = parser.parse(file).units[0];

    expect(first?.id).toBe(second?.id);
    expect(first?.sourceIdentity).toBe(second?.sourceIdentity);
  });
});
