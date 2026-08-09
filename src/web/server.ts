import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadLocalEnvironment } from "../config/load-environment.js";
import type { ExecutionPermissions } from "../domain/task-execution.js";
import type { ConfigurableProviderId, ImportedRepositoryFile, ProductAnalysisDepth, ProductChangeSetSource, ProviderModelsInput, SaveProviderSettingsInput } from "./contracts.js";
import { ConclaveProductService, ProductServiceError } from "./product-service.js";

const BODY_LIMIT_BYTES = 64_000;
const IMPORT_BODY_LIMIT_BYTES = 20_000_000;
const REVIEW_BODY_LIMIT_BYTES = 2_500_000;
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function body(request: IncomingMessage, limit = BODY_LIMIT_BYTES): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new ProductServiceError("invalid_body", "Request body must be byte data.", "Try the web application again.");
    const value: Uint8Array = chunk;
    size += value.byteLength;
    if (size > limit) throw new ProductServiceError("body_too_large", "Request body exceeds the local API limit.", "Submit a smaller request.");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProductServiceError("invalid_json", "Request body must be valid JSON.", "Try again with a valid request.");
  }
  if (!isRecord(parsed)) throw new ProductServiceError("invalid_request", "Request body must be an object.", "Try again.");
  return parsed;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ProductServiceError("invalid_request", `${label} is required.`, "Provide the missing value.");
  return value;
}

function boolean(value: unknown): boolean {
  return value === true;
}

function analysisDepth(value: unknown): ProductAnalysisDepth {
  if (value === undefined) return "auto";
  if (value !== "auto" && value !== "fast" && value !== "balanced" && value !== "deep") {
    throw new ProductServiceError("invalid_depth", "Analysis depth must be Auto, Fast, Balanced, or Deep.", "Choose a supported analysis depth.");
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function changeSetSource(value: unknown): ProductChangeSetSource {
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    throw new ProductServiceError("invalid_change_source", "Choose a Review ChangeSet source.", "Select working tree, staged, branch, commit, or explicit diff.");
  }
  switch (value["kind"]) {
    case "working-tree": return { kind: "working-tree" };
    case "staged": return { kind: "staged" };
    case "branch": {
      const head = optionalString(value["head"]);
      return { kind: "branch", base: string(value["base"], "Base branch"), ...(head === undefined ? {} : { head }) };
    }
    case "commit": return {
      kind: "commit",
      base: string(value["base"], "Base commit"),
      target: string(value["target"], "Target commit"),
    };
    case "explicit": {
      const label = optionalString(value["label"]);
      return { kind: "explicit", ...(label === undefined ? {} : { label }) };
    }
    default:
      throw new ProductServiceError("invalid_change_source", "The Review ChangeSet source is not supported.", "Choose working tree, staged, branch, commit, or explicit diff.");
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function permissions(value: unknown): ExecutionPermissions {
  const parsed = isRecord(value) ? value : {};
  return {
    allowFileEdits: boolean(parsed["allowFileEdits"]),
    allowCommands: boolean(parsed["allowCommands"]),
    allowRepositoryScripts: boolean(parsed["allowRepositoryScripts"]),
    allowNetwork: boolean(parsed["allowNetwork"]),
  };
}

function providerSettings(value: Record<string, unknown>): SaveProviderSettingsInput {
  if (!Array.isArray(value["sets"])) throw new ProductServiceError("invalid_request", "Provider sets are required.", "Reload Settings and try again.");
  return {
    ...(typeof value["activeSetId"] === "string" ? { activeSetId: value["activeSetId"] } : {}),
    sets: value["sets"] as SaveProviderSettingsInput["sets"],
  };
}

function providerModels(value: Record<string, unknown>): ProviderModelsInput {
  return {
    provider: string(value["provider"], "Provider") as ConfigurableProviderId,
    ...(typeof value["apiKey"] === "string" ? { apiKey: value["apiKey"] } : {}),
    ...(typeof value["setId"] === "string" ? { setId: value["setId"] } : {}),
    ...(typeof value["connectionId"] === "string" ? { connectionId: value["connectionId"] } : {}),
  };
}

function importedFiles(value: unknown): readonly ImportedRepositoryFile[] {
  if (!Array.isArray(value)) throw new ProductServiceError("invalid_request", "A repository folder selection is required.", "Choose a folder and try again.");
  return value.map((file) => {
    if (!isRecord(file) || typeof file["path"] !== "string" || typeof file["content"] !== "string") {
      throw new ProductServiceError("invalid_repository_file", "A selected repository file could not be read.", "Choose the folder again.");
    }
    return { path: file["path"], content: file["content"] };
  });
}

function safeStaticPath(root: string, pathname: string): string {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return resolve(root, "index.html");
  return candidate;
}

export interface ConclaveWebServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly staticRoot?: string;
  readonly product?: ConclaveProductService;
}

export function createConclaveWebServer(options: ConclaveWebServerOptions = {}) {
  const product = options.product ?? new ConclaveProductService();
  const staticRoot = resolve(options.staticRoot ?? "dist/web-client");
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/api/health" && request.method === "GET") { send(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/runtime" && request.method === "GET") { send(response, 200, await product.runtime()); return; }
      if (url.pathname === "/api/metrics/adaptive" && request.method === "GET") { send(response, 200, product.adaptiveMetrics()); return; }
      if (url.pathname === "/api/settings/providers" && request.method === "GET") { send(response, 200, await product.providerSettings()); return; }
      if (url.pathname === "/api/settings/providers" && request.method === "PUT") {
        send(response, 200, await product.saveProviderSettings(providerSettings(await body(request))));
        return;
      }
      if (url.pathname === "/api/settings/provider-models" && request.method === "POST") {
        send(response, 200, await product.providerModels(providerModels(await body(request))));
        return;
      }
      if (url.pathname === "/api/projects/demo" && request.method === "POST") { send(response, 200, await product.openDemo()); return; }
      if (url.pathname === "/api/projects/open" && request.method === "POST") {
        const payload = await body(request);
        send(response, 200, await product.openLocal(string(payload["path"], "Repository path")));
        return;
      }
      if (url.pathname === "/api/projects/import" && request.method === "POST") {
        const payload = await body(request, IMPORT_BODY_LIMIT_BYTES);
        send(response, 200, await product.importLocal(string(payload["name"], "Repository name"), importedFiles(payload["files"])));
        return;
      }
      if (url.pathname === "/api/review" && request.method === "POST") {
        const payload = await body(request, REVIEW_BODY_LIMIT_BYTES);
        const source = changeSetSource(payload["source"]);
        const explicitDiff = source.kind === "explicit" && typeof payload["diff"] === "string" ? payload["diff"] : undefined;
        send(response, 200, await product.review(
          string(payload["projectId"], "Project"),
          source,
          explicitDiff,
          optionalString(payload["objective"]),
          analysisDepth(payload["depth"]),
        ));
        return;
      }
      if (url.pathname === "/api/decide" && request.method === "POST") {
        const payload = await body(request);
        if (typeof payload["proposal"] !== "string") throw new ProductServiceError("invalid_request", "Proposal is required.", "Describe the proposal to validate.");
        send(response, 200, await product.decide(
          string(payload["projectId"], "Project"),
          payload["proposal"],
          optionalString(payload["objective"]),
          analysisDepth(payload["depth"]),
        ));
        return;
      }
      if (url.pathname === "/api/run" && request.method === "POST") {
        const payload = await body(request);
        const intent = string(payload["intent"], "Intent");
        if (intent !== "ask" && intent !== "investigate") throw new ProductServiceError("invalid_intent", "This endpoint supports Ask and Investigate only.", "Select an explicit read-only intent.");
        send(response, 200, await product.run(string(payload["projectId"], "Project"), intent, string(payload["query"], "Question"), analysisDepth(payload["depth"])));
        return;
      }
      if (url.pathname === "/api/runs" && request.method === "POST") {
        const payload = await body(request);
        const intent = string(payload["intent"], "Intent");
        if (intent !== "ask" && intent !== "investigate") throw new ProductServiceError("invalid_intent", "This endpoint supports Ask and Investigate only.", "Select an explicit read-only intent.");
        send(response, 202, product.startRun(string(payload["projectId"], "Project"), intent, string(payload["query"], "Question"), analysisDepth(payload["depth"])));
        return;
      }
      const runStatus = /^\/api\/runs\/([0-9a-f-]+)$/i.exec(url.pathname);
      if (runStatus !== null && request.method === "GET") {
        const runId = runStatus[1];
        if (runId !== undefined) send(response, 200, product.runStatus(runId));
        return;
      }
      if (runStatus !== null && request.method === "DELETE") {
        const runId = runStatus[1];
        if (runId !== undefined) send(response, 202, product.cancelRun(runId));
        return;
      }
      if (url.pathname === "/api/task" && request.method === "POST") {
        const payload = await body(request);
        send(response, 200, await product.task(string(payload["projectId"], "Project"), string(payload["objective"], "Task objective"), boolean(payload["planOnly"]), permissions(payload["permissions"]), analysisDepth(payload["depth"])));
        return;
      }
      if (url.pathname === "/api/task/runs" && request.method === "POST") {
        const payload = await body(request);
        send(response, 202, product.startTask(
          string(payload["projectId"], "Project"),
          string(payload["objective"], "Task objective"),
          boolean(payload["planOnly"]),
          permissions(payload["permissions"]),
          analysisDepth(payload["depth"]),
        ));
        return;
      }
      if (url.pathname === "/api/graph" && request.method === "GET") {
        send(response, 200, product.graph(string(url.searchParams.get("projectId"), "Project"), string(url.searchParams.get("symbol"), "Symbol")));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { send(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed.", action: "Use the local web application." } }); return; }
      let path = safeStaticPath(staticRoot, url.pathname);
      const details = await stat(path).catch(() => undefined);
      if (details === undefined || !details.isFile()) path = resolve(staticRoot, "index.html");
      const content = await readFile(path);
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      const known = error instanceof ProductServiceError;
      send(response, known ? 400 : 500, {
        error: {
          code: known ? error.code : "internal_error",
          message: known ? error.message : "Conclave local server could not complete this request.",
          action: known ? error.action : "Check the local server logs and retry.",
        },
      });
    }
  };
  return createServer((request, response) => { void handler(request, response); });
}

const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntry) {
  await loadLocalEnvironment();
  const port = Number(process.env["CONCLAVE_WEB_PORT"] ?? "4317");
  const server = createConclaveWebServer();
  server.once("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Conclave could not start: port ${String(port)} is already in use. Stop the existing Conclave server or run with CONCLAVE_WEB_PORT=${String(port + 1)}.`);
    } else {
      console.error(`Conclave could not start the local web server: ${error.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Conclave web server listening on http://127.0.0.1:${String(port)}`);
  });
}
