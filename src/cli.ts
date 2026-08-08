#!/usr/bin/env node

import { resolve } from "node:path";

import { describeRuntimeConfig, loadRuntimeConfig } from "./config/runtime-config.js";
import { createProvider } from "./providers/provider-factory.js";
import { LocalFolderRepository } from "./repositories/local-folder-repository.js";
import { EnvironmentCredentialSource } from "./storage/environment-credential-source.js";

const HELP = `Conclave foundation CLI

Usage:
  conclave scan [path] [--json]   Safely inspect a local repository
  conclave config [--json]        Show effective, credential-safe mode configuration
  conclave provider-check         Exercise the configured provider adapter
  conclave help                   Show this help

This Phase 1 CLI does not perform RAG or multi-agent analysis.`;

function print(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, undefined, 2));
    return;
  }
  console.log(value);
}

async function scan(args: readonly string[]): Promise<void> {
  const json = args.includes("--json");
  const requestedPath = args.find((argument) => argument !== "--json") ?? ".";
  const snapshot = await new LocalFolderRepository().load({ path: resolve(requestedPath) });
  const languageCounts = Object.fromEntries(
    [...new Set(snapshot.files.map((file) => file.language))]
      .sort()
      .map((language) => [
        language,
        snapshot.files.filter((file) => file.language === language).length,
      ]),
  );
  const report = {
    repository: snapshot.repository,
    scannedAt: snapshot.scannedAt,
    stats: snapshot.stats,
    languages: languageCounts,
  };

  if (json) {
    print(report, true);
    return;
  }
  console.log(`Repository: ${snapshot.repository.name} (${snapshot.repository.rootPath})`);
  console.log(
    `Loaded: ${String(snapshot.stats.filesLoaded)} files / ${String(snapshot.stats.bytesLoaded)} bytes`,
  );
  console.log(`Languages: ${JSON.stringify(languageCounts)}`);
  console.log(`External-context blocked: ${String(snapshot.stats.safetyBlockedFiles)} files`);
  console.log(
    `Skipped: ${String(snapshot.stats.ignoredEntries)} ignored, ${String(snapshot.stats.skippedBinaryFiles)} binary, ${String(snapshot.stats.skippedOversizedFiles)} oversized, ${String(snapshot.stats.skippedSymlinks)} symlinks`,
  );
}

function showConfig(args: readonly string[]): void {
  const credentials = new EnvironmentCredentialSource();
  const report = describeRuntimeConfig(loadRuntimeConfig(), credentials);
  print(report, args.includes("--json"));
}

async function providerCheck(): Promise<void> {
  const credentials = new EnvironmentCredentialSource();
  const config = loadRuntimeConfig();
  const model = config.providerSelection.model;
  if (model === undefined) {
    throw new Error(
      config.mode === "free"
        ? "CONCLAVE_FREE_MODEL is required for provider-check"
        : "CONCLAVE_MODEL is required for provider-check",
    );
  }
  const provider = createProvider(config, credentials);
  const response = await provider.generate({
    model,
    messages: [
      {
        role: "system",
        content: "This is a connectivity check. Reply with exactly CONCLAVE_PROVIDER_OK.",
      },
      { role: "user", content: "Check provider connectivity." },
    ],
    maxOutputTokens: 32,
  });
  console.log(`${response.provider}/${response.model}: ${response.text}`);
}

async function main(): Promise<void> {
  const [command = "help", ...args] = process.argv.slice(2);
  switch (command) {
    case "scan":
      await scan(args);
      return;
    case "config":
      showConfig(args);
      return;
    case "provider-check":
      await providerCheck();
      return;
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

await main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "Unknown error";
  console.error(`Conclave error: ${message}`);
  process.exitCode = 1;
});
