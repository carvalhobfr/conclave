#!/usr/bin/env node

import { access, cp, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function parseArguments(argv) {
  const parsed = { target: "both", scope: "project", project: process.cwd(), force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--force") { parsed.force = true; continue; }
    if (argument === "--dry-run") { parsed.dryRun = true; continue; }
    if (!["--target", "--scope", "--project", "--destination"].includes(argument)) throw new Error(`Unknown option: ${argument ?? ""}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    parsed[argument.slice(2)] = value;
    index += 1;
  }
  if (!["codex", "claude", "both", "portable", "github-actions"].includes(parsed.target)) throw new Error("--target must be codex, claude, both, portable, or github-actions");
  if (!["project", "user"].includes(parsed.scope)) throw new Error("--scope must be project or user");
  if (parsed.target === "portable" && parsed.destination === undefined) throw new Error("--destination is required for portable installation");
  if (parsed.target !== "portable" && parsed.destination !== undefined) throw new Error("--destination is only valid with --target portable");
  if (parsed.target === "github-actions" && parsed.scope !== "project") throw new Error("--target github-actions only supports --scope project");
  return parsed;
}

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function sameSkill(source, destination) {
  try {
    const files = [
      "SKILL.md",
      "agents/openai.yaml",
      "scripts/run-validation.mjs",
      "references/report-schema.md",
    ];
    const comparisons = await Promise.all(files.map(async (file) => {
      const [left, right] = await Promise.all([
        readFile(resolve(source, file), "utf8"),
        readFile(resolve(destination, file), "utf8"),
      ]);
      return left === right;
    }));
    return comparisons.every(Boolean);
  } catch {
    return false;
  }
}

async function sameFile(source, destination) {
  try {
    return await readFile(source, "utf8") === await readFile(destination, "utf8");
  } catch {
    return false;
  }
}

function destinations(parsed) {
  if (parsed.target === "portable") return [resolve(parsed.destination)];
  const root = parsed.scope === "user" ? homedir() : resolve(parsed.project);
  if (parsed.target === "github-actions") return [resolve(root, ".github/workflows/conclave-review.yml")];
  const selected = parsed.target === "both" ? ["codex", "claude"] : [parsed.target];
  return selected.map((target) => resolve(root, target === "codex" ? ".agents/skills/conclave-validate" : ".claude/skills/conclave-validate"));
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const source = resolve(dirname(fileURLToPath(import.meta.url)), "../skills/conclave-validate");
  const workflowSource = resolve(dirname(fileURLToPath(import.meta.url)), "../examples/github-actions/conclave-review.yml");
  for (const destination of destinations(parsed)) {
    if (await exists(destination)) {
      const identical = parsed.target === "github-actions"
        ? await sameFile(workflowSource, destination)
        : await sameSkill(source, destination);
      if (identical) {
        process.stdout.write(`Already installed: ${destination}\n`);
        continue;
      }
      if (!parsed.force) throw new Error(`Refusing to replace a different skill at ${destination}; use --force after reviewing it`);
    }
    if (!parsed.dryRun) {
      await mkdir(dirname(destination), { recursive: true });
      if (parsed.target === "github-actions") await cp(workflowSource, destination, { force: true });
      else await cp(source, destination, { recursive: true, force: true });
    }
    process.stdout.write(`${parsed.dryRun ? "Would install" : "Installed"}: ${destination}\n`);
  }
}

await main().catch((error) => {
  process.stderr.write(`Skill installation error: ${error instanceof Error ? error.message : "Unknown error"}\n`);
  process.exitCode = 1;
});
