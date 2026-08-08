import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TypeScriptCodeParser } from "../src/code-intelligence/typescript-parser.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { GraphQueryService } from "../src/graph/graph-query.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";

async function graphQueryFixture() {
  const root = await mkdtemp(join(tmpdir(), "conclave-graph-query-"));
  await mkdir(join(root, "src"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "src", "contracts.ts"),
      `export interface TokenReader { read(): string | null }
export class BaseController {}
`,
    ),
    writeFile(
      join(root, "src", "storage.ts"),
      `export function getStoredToken() {
  return localStorage.getItem("token");
}
export function persistToken(token: string) {
  localStorage.setItem("token", token);
}
export function duplicate() { return "storage"; }
`,
    ),
    writeFile(
      join(root, "src", "flow.ts"),
      `import { getStoredToken, persistToken } from "./storage";
import { BaseController, TokenReader } from "./contracts";
export function authenticate() {
  const token = getStoredToken();
  persistToken(token ?? "");
  return token;
}
export function login() {
  return authenticate();
}
export function LoginButton() {
  return login();
}
export class SessionController extends BaseController implements TokenReader {
  read() {
    return getStoredToken();
  }
}
`,
    ),
    writeFile(join(root, "src", "duplicate.ts"), "export function duplicate() { return 'other'; }\n"),
  ]);
  const embeddingProvider = new LocalHashEmbeddingProvider();
  const indexed = await new RepositoryIndexer({
    repositorySource: new LocalFolderRepository(),
    parser: new TypeScriptCodeParser(),
    embeddingProvider,
    indexStore: new InMemoryCodeIndexStore(),
  }).index(root);
  return new GraphQueryService(indexed.index);
}

function resolvedReference(
  resolution: ReturnType<GraphQueryService["getNodeBySymbol"]>,
) {
  expect(resolution.status).toBe("resolved");
  if (resolution.status !== "resolved") {
    throw new Error("Expected a resolved graph node");
  }
  return resolution.node.reference;
}

describe("first-class graph queries", () => {
  it("resolves symbol and file nodes without silently choosing ambiguous symbols", async () => {
    const graph = await graphQueryFixture();

    const authenticate = graph.getNodeBySymbol("authenticate");
    expect(authenticate.status).toBe("resolved");
    if (authenticate.status === "resolved") expect(authenticate.node.path).toBe("src/flow.ts");
    const storage = graph.getNodeByFile("src/storage.ts");
    expect(storage.status).toBe("resolved");
    if (storage.status === "resolved") expect(storage.node.path).toBe("src/storage.ts");
    const ambiguous = graph.getNodeBySymbol("duplicate");
    expect(ambiguous.status).toBe("ambiguous");
    if (ambiguous.status === "ambiguous") {
      expect(ambiguous.candidates.map((candidate) => candidate.path)).toEqual([
        "src/duplicate.ts",
        "src/storage.ts",
      ]);
    }
    expect(graph.getNodeBySymbol("duplicate", undefined, 1).status).toBe("ambiguous");
  });

  it("queries incoming, outgoing, callers, callees, references, imports, and exports", async () => {
    const graph = await graphQueryFixture();
    const authenticate = resolvedReference(graph.getNodeBySymbol("authenticate"));
    const login = resolvedReference(graph.getNodeBySymbol("login"));
    const storage = graph.getNodeByFile("src/storage.ts");
    if (storage.status !== "resolved") throw new Error("Expected storage file");

    expect(graph.incomingEdges(authenticate, { maxNodes: 20 }).length).toBeGreaterThan(0);
    expect(graph.outgoingEdges(authenticate, { maxNodes: 20 }).length).toBeGreaterThan(0);
    expect(graph.callers(authenticate, { maxNodes: 20 }).map((result) => result.node.symbol)).toContain("login");
    expect(graph.callees(login, { maxNodes: 20 }).map((result) => result.node.symbol)).toContain("authenticate");
    expect(graph.references(resolvedReference(graph.getNodeBySymbol("getStoredToken")), { maxNodes: 20 }).map((result) => result.node.symbol)).toContain("authenticate");
    expect(graph.imports(resolvedReference(graph.getNodeByFile("src/flow.ts")), { maxNodes: 20 }).map((result) => result.node.path)).toContain("src/storage.ts");
    expect(graph.exports(storage.node.reference, { maxNodes: 20 }).map((result) => result.node.symbol)).toContain("persistToken");
  });

  it("queries containment, related files, typed relations, and source provenance", async () => {
    const graph = await graphQueryFixture();
    const controller = resolvedReference(graph.getNodeBySymbol("SessionController"));
    const read = resolvedReference(graph.getNodeBySymbol("read"));

    expect(graph.containedSymbols(controller, { maxDepth: 2, maxNodes: 20 }).map((result) => result.node.symbol)).toContain("read");
    expect(graph.containingSymbol(read, { maxNodes: 20 }).map((result) => result.node.symbol)).toEqual(["SessionController"]);
    expect(graph.outgoingEdges(controller, { maxNodes: 30 }).map((result) => result.edge.relation)).toEqual(
      expect.arrayContaining(["belongs-to-file", "contains-symbol", "extends-symbol", "implements-symbol"]),
    );
    expect(graph.relatedFiles(controller, { maxDepth: 3, maxNodes: 30 }).map((result) => result.node.path)).toEqual(
      expect.arrayContaining(["src/flow.ts", "src/contracts.ts"]),
    );
    const provenance = graph
      .outgoingEdges(controller, { maxNodes: 30 })
      .find((result) => result.edge.relation === "extends-symbol")?.edge.provenance;
    expect(provenance).toEqual(
      expect.objectContaining({
        kind: "resolved",
        path: "src/flow.ts",
        line: 14,
        resolutionMethod: "imported-identifier",
      }),
    );
  });

  it("returns deterministic bounded subgraphs and shortest paths", async () => {
    const graph = await graphQueryFixture();
    const loginButton = resolvedReference(graph.getNodeBySymbol("LoginButton"));

    const limited = graph.boundedSubgraph(loginButton, { maxDepth: 1, maxNodes: 2, maxEdges: 2 });
    expect(limited.nodes.length).toBeLessThanOrEqual(2);
    expect(limited.edges.length).toBeLessThanOrEqual(2);
    expect(limited.nodes.map((node) => node.reference.id).length).toBe(
      new Set(limited.nodes.map((node) => node.reference.id)).size,
    );

    const tooShallow = graph.shortestPathBetweenSymbols("LoginButton", "persistToken", {
      maxDepth: 2,
      maxNodes: 30,
    });
    expect(tooShallow.status).toBe("no-path");
    const path = graph.shortestPathBetweenSymbols("LoginButton", "persistToken", {
      maxDepth: 4,
      maxNodes: 30,
    });
    expect(path.status).toBe("found");
    if (path.status === "found") {
      expect(path.nodes.map((node) => node.symbol)).toEqual([
        "LoginButton",
        "login",
        "authenticate",
        "persistToken",
      ]);
      expect(path.edges.map((edge) => edge.relation)).toEqual([
        "calls-symbol",
        "calls-symbol",
        "calls-symbol",
      ]);
      expect(path.edges.every((edge) => edge.provenance.line !== undefined)).toBe(true);
    }

    expect(graph.shortestPathBetweenSymbols("duplicate", "persistToken", { maxDepth: 4, maxNodes: 30 })).toEqual(
      expect.objectContaining({ status: "ambiguous", endpoint: "from" }),
    );
  });
});
