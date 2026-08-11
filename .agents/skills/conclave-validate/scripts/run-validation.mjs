#!/usr/bin/env node

import { access, mkdir, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const MAX_OUTPUT_BYTES = 10_000_000;
const TIMEOUT_MS = 120_000;
const VERDICT_EXIT = { pass: 0, warn: 0, block: 1, inconclusive: 2 };

function parseArguments(argv) {
  const parsed = { repository: ".", source: "working" };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!["--repository", "--source", "--ref", "--objective", "--contract", "--output"].includes(name)) {
      throw new Error(`Unknown option: ${name ?? ""}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${name} requires a value`);
    parsed[name.slice(2)] = value;
    index += 1;
  }
  if (typeof parsed.objective !== "string" || parsed.objective.trim() === "") {
    throw new Error("--objective is required; validation without an intended resolution is inconclusive");
  }
  if (!["working", "staged", "branch", "commit"].includes(parsed.source)) {
    throw new Error("--source must be working, staged, branch, or commit");
  }
  if ((parsed.source === "branch" || parsed.source === "commit") && parsed.ref === undefined) {
    throw new Error(`--ref is required for ${parsed.source} validation`);
  }
  if ((parsed.source === "working" || parsed.source === "staged") && parsed.ref !== undefined) {
    throw new Error(`--ref is not valid for ${parsed.source} validation`);
  }
  return parsed;
}

async function executable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommand(repository) {
  const explicitEntrypoint = process.env.CONCLAVE_CLI_PATH;
  if (explicitEntrypoint !== undefined) {
    const path = resolve(explicitEntrypoint);
    if (!(await executable(path))) throw new Error(`CONCLAVE_CLI_PATH is not readable: ${path}`);
    return { command: process.execPath, prefix: [path] };
  }
  const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const entrypoints = [
    resolve(repository, "dist/cli.js"),
    resolve(skillRoot, "dist/cli.js"),
    resolve(repository, "node_modules/conclave/dist/cli.js"),
  ];
  for (const path of entrypoints) {
    if (await executable(path)) return { command: process.execPath, prefix: [path] };
  }
  const localBinary = resolve(repository, "node_modules/.bin/conclave");
  if (await executable(localBinary)) return { command: localBinary, prefix: [] };
  if (process.env.CONCLAVE_BIN !== undefined) {
    return { command: process.env.CONCLAVE_BIN, prefix: [] };
  }
  throw new Error("Conclave executable was not found. Build Conclave, install it in the target repository, or set CONCLAVE_CLI_PATH.");
}

function commandArguments(parsed) {
  const args = ["review", resolve(parsed.repository), `--${parsed.source}`];
  if (parsed.ref !== undefined) args.push(parsed.ref);
  args.push("--objective", parsed.objective.trim());
  if (parsed.contract !== undefined) args.push("--contract", resolve(parsed.contract));
  args.push("--json");
  return args;
}

function execute(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let settled = false;
    const append = (target, chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        if (!settled) {
          settled = true;
          reject(new Error("Conclave output exceeded 10 MB"));
        }
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", (chunk) => append(stdout, chunk));
    child.stderr.on("data", (chunk) => append(stderr, chunk));
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      if (!settled) {
        settled = true;
        reject(new Error("Conclave validation timed out after 120 seconds"));
      }
    }, TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timeout);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolvePromise({
        code: code ?? 3,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

function validateReport(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Conclave did not return a JSON object");
  if (value.schemaVersion !== 1) throw new Error("Unsupported Conclave validation schema version");
  if (!Object.hasOwn(VERDICT_EXIT, value.verdict)) throw new Error("Conclave returned an unknown verdict");
  for (const field of ["summary", "objective"]) {
    if (typeof value[field] !== "string") throw new Error(`Conclave report is missing ${field}`);
  }
  for (const field of ["findings", "claims"]) {
    if (!Array.isArray(value[field])) throw new Error(`Conclave report is missing ${field}`);
  }
  if (typeof value.changeSet !== "object" || value.changeSet === null) throw new Error("Conclave report is missing changeSet");
  if (typeof value.impact !== "object" || value.impact === null) throw new Error("Conclave report is missing impact");
  if (typeof value.metrics !== "object" || value.metrics === null) throw new Error("Conclave report is missing metrics");
  if (typeof value.trustBoundary !== "object" || value.trustBoundary === null || Array.isArray(value.trustBoundary)) {
    throw new Error("Conclave report is missing trustBoundary");
  }
  const trustBoundary = value.trustBoundary;
  if (
    trustBoundary.deterministic !== true ||
    trustBoundary.reasoningModelCalls !== 0 ||
    trustBoundary.repositoryScriptsExecuted !== false
  ) {
    throw new Error("Conclave report violates the deterministic validation trust boundary");
  }
  return value;
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const repository = resolve(parsed.repository);
  const resolved = await resolveCommand(repository);
  const result = await execute(resolved.command, [...resolved.prefix, ...commandArguments(parsed)], repository);
  let report;
  try {
    report = validateReport(JSON.parse(result.stdout.trim()));
  } catch (error) {
    const detail = result.stderr.trim();
    throw new Error(
      `${error instanceof Error ? error.message : "Invalid JSON report"}${detail === "" ? "" : `: ${detail}`}`,
      { cause: error },
    );
  }
  const expectedExit = VERDICT_EXIT[report.verdict];
  if (result.code !== expectedExit) {
    throw new Error(`Report verdict ${report.verdict} requires exit ${expectedExit}, but Conclave exited ${result.code}`);
  }
  const output = `${JSON.stringify(report, undefined, 2)}\n`;
  if (parsed.output !== undefined) {
    const path = resolve(parsed.output);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, output, "utf8");
  }
  process.stdout.write(output);
  process.exitCode = expectedExit;
}

await main().catch((error) => {
  process.stderr.write(`Conclave skill error: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 3;
});
