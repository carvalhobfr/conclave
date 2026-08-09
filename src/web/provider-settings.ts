import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import { loadReasoningConfiguration } from "../config/reasoning-config.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import { loadTaskConfiguration } from "../config/task-config.js";
import { EnvironmentCredentialSource } from "../storage/environment-credential-source.js";
import type {
  ConfigurableProviderId,
  EnvironmentProviderView,
  ProviderCatalogItemView,
  ProviderConnectionInput,
  ProviderRole,
  ProviderRoleAssignmentView,
  ProviderSetInput,
  ProviderSettingsView,
  SaveProviderSettingsInput,
} from "./contracts.js";

export const MAX_PROVIDER_SETS = 5 as const;
const MAX_CONNECTIONS_PER_SET = 5;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const ROLES: readonly ProviderRole[] = [
  "investigator",
  "skeptic",
  "architect",
  "verifier",
  "judge",
  "planner",
  "implementer",
  "reviewer",
];

export const PROVIDER_CATALOG: readonly ProviderCatalogItemView[] = [
  { id: "openai", name: "OpenAI (GPT)", local: false, requiresApiKey: true, defaultBaseUrl: "https://api.openai.com/v1", modelPlaceholder: "gpt-5-mini" },
  { id: "openrouter", name: "OpenRouter", local: false, requiresApiKey: true, defaultBaseUrl: "https://openrouter.ai/api/v1", modelPlaceholder: "openai/gpt-4.1-mini" },
  { id: "ollama", name: "Ollama", local: true, requiresApiKey: false, defaultBaseUrl: "http://127.0.0.1:11434/v1", modelPlaceholder: "qwen3:8b" },
  { id: "lm-studio", name: "LM Studio", local: true, requiresApiKey: false, defaultBaseUrl: "http://127.0.0.1:1234/v1", modelPlaceholder: "loaded-model" },
  { id: "openai-compatible", name: "OpenAI compatible", local: false, requiresApiKey: true, modelPlaceholder: "model-name" },
];

export interface StoredProviderConnection {
  readonly id: string;
  readonly provider: ConfigurableProviderId;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
}

export interface StoredProviderSet {
  readonly id: string;
  readonly name: string;
  readonly providers: readonly StoredProviderConnection[];
  readonly roles: readonly ProviderRoleAssignmentView[];
}

interface StoredProviderSettings {
  readonly version: 1;
  readonly activeSetId?: string;
  readonly sets: readonly StoredProviderSet[];
}

export class ProviderSettingsError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderSettingsError";
  }
}

function settingsPath(environment: NodeJS.ProcessEnv): string {
  const configured = environment["CONCLAVE_SETTINGS_FILE"]?.trim();
  if (configured !== undefined && configured !== "") return resolve(configured);
  return resolve(homedir(), ".conclave", "provider-settings.json");
}

function nonEmpty(value: unknown, label: string, maximum = 200): string {
  if (typeof value !== "string") throw new ProviderSettingsError(`${label} is required.`);
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maximum) throw new ProviderSettingsError(`${label} must contain between 1 and ${String(maximum)} characters.`);
  return trimmed;
}

function identifier(value: unknown, label: string): string {
  const parsed = nonEmpty(value, label, 80);
  if (!SAFE_ID.test(parsed)) throw new ProviderSettingsError(`${label} contains unsupported characters.`);
  return parsed;
}

function catalogItem(provider: unknown): ProviderCatalogItemView {
  const item = PROVIDER_CATALOG.find((candidate) => candidate.id === provider);
  if (item === undefined) throw new ProviderSettingsError(`Unsupported provider: ${String(provider)}.`);
  return item;
}

function validatedBaseUrl(item: ProviderCatalogItemView, requested: unknown): string | undefined {
  const raw = typeof requested === "string" && requested.trim() !== "" ? requested.trim() : item.defaultBaseUrl;
  if (raw === undefined) throw new ProviderSettingsError(`A base URL is required for ${item.name}.`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProviderSettingsError(`The base URL for ${item.name} is invalid.`);
  }
  if (parsed.username !== "" || parsed.password !== "" || parsed.search !== "" || parsed.hash !== "") {
    throw new ProviderSettingsError("Provider URLs cannot contain credentials, query parameters, or fragments.");
  }
  if (item.local) {
    if (!new Set(["127.0.0.1", "[::1]", "localhost"]).has(parsed.hostname)) {
      throw new ProviderSettingsError(`${item.name} must use a loopback address.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ProviderSettingsError(`${item.name} must use HTTP or HTTPS.`);
    }
  } else if (parsed.protocol !== "https:") {
    throw new ProviderSettingsError(`${item.name} must use HTTPS.`);
  }
  return parsed.toString().replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function displayModelName(model: string): string {
  return model.split("-").map((part) => {
    if (/^v\d+$/i.test(part)) return part.toUpperCase();
    if (part.toLowerCase() === "deepseek") return "DeepSeek";
    return part.length === 0 ? part : `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`;
  }).join(" ");
}

function existingConnection(
  previous: StoredProviderSettings,
  setId: string,
  connectionId: string,
): StoredProviderConnection | undefined {
  return previous.sets.find((set) => set.id === setId)?.providers.find((connection) => connection.id === connectionId);
}

function validatedSettings(input: SaveProviderSettingsInput, previous: StoredProviderSettings): StoredProviderSettings {
  const requestedSets: unknown = input.sets;
  if (!Array.isArray(requestedSets) || requestedSets.length > MAX_PROVIDER_SETS) {
    throw new ProviderSettingsError(`You can save up to ${String(MAX_PROVIDER_SETS)} provider sets.`);
  }
  const setIds = new Set<string>();
  const sets = (requestedSets as readonly ProviderSetInput[]).map((set) => {
    const id = identifier(set.id, "Set identifier");
    if (setIds.has(id)) throw new ProviderSettingsError("Provider set identifiers must be unique.");
    setIds.add(id);
    const name = nonEmpty(set.name, "Set name", 48);
    const requestedProviders: unknown = set.providers;
    if (!Array.isArray(requestedProviders) || requestedProviders.length < 1 || requestedProviders.length > MAX_CONNECTIONS_PER_SET) {
      throw new ProviderSettingsError(`Each set needs between 1 and ${String(MAX_CONNECTIONS_PER_SET)} provider connections.`);
    }
    const connectionIds = new Set<string>();
    const providers = (requestedProviders as readonly ProviderConnectionInput[]).map((connection) => {
      const connectionId = identifier(connection.id, "Provider connection identifier");
      if (connectionIds.has(connectionId)) throw new ProviderSettingsError(`Provider connections in ${name} must be unique.`);
      connectionIds.add(connectionId);
      const item = catalogItem(connection.provider);
      const model = nonEmpty(connection.model, `${item.name} model`);
      const baseUrl = validatedBaseUrl(item, connection.baseUrl);
      const requestedKey = typeof connection.apiKey === "string" ? connection.apiKey.trim() : "";
      const retainedKey = existingConnection(previous, id, connectionId)?.apiKey;
      const apiKey = item.requiresApiKey ? (requestedKey === "" ? retainedKey : requestedKey) : undefined;
      if (item.requiresApiKey && apiKey === undefined) {
        throw new ProviderSettingsError(`${item.name} requires your own API key in this set.`);
      }
      if (apiKey !== undefined && apiKey.length > 4096) throw new ProviderSettingsError(`${item.name} API key is too long.`);
      return { id: connectionId, provider: item.id, model, ...(baseUrl === undefined ? {} : { baseUrl }), ...(apiKey === undefined ? {} : { apiKey }) };
    });
    const requestedRoles: unknown = set.roles;
    if (!Array.isArray(requestedRoles) || requestedRoles.length !== ROLES.length) {
      throw new ProviderSettingsError(`Every provider set must assign all ${String(ROLES.length)} roles.`);
    }
    const assignedRoles = new Set<ProviderRole>();
    const roles = (requestedRoles as readonly ProviderRoleAssignmentView[]).map((assignment) => {
      if (!ROLES.includes(assignment.role) || assignedRoles.has(assignment.role)) {
        throw new ProviderSettingsError(`Every role in ${name} must be assigned exactly once.`);
      }
      assignedRoles.add(assignment.role);
      const connectionId = identifier(assignment.connectionId, `${assignment.role} provider`);
      if (!connectionIds.has(connectionId)) throw new ProviderSettingsError(`${assignment.role} references a provider that is not in ${name}.`);
      return { role: assignment.role, connectionId, model: nonEmpty(assignment.model, `${assignment.role} model`) };
    });
    return { id, name, providers, roles };
  });
  const activeSetId = typeof input.activeSetId === "string" && input.activeSetId.trim() !== "" ? identifier(input.activeSetId, "Active set") : undefined;
  if (activeSetId !== undefined && !setIds.has(activeSetId)) throw new ProviderSettingsError("The active provider set no longer exists.");
  return { version: 1, ...(activeSetId === undefined ? {} : { activeSetId }), sets };
}

function parseStored(content: string): StoredProviderSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new ProviderSettingsError("The local provider settings file is not valid JSON.");
  }
  if (!isRecord(parsed) || parsed["version"] !== 1 || !Array.isArray(parsed["sets"])) {
    throw new ProviderSettingsError("The local provider settings file has an unsupported format.");
  }
  return validatedSettings({
    ...(typeof parsed["activeSetId"] === "string" ? { activeSetId: parsed["activeSetId"] } : {}),
    sets: parsed["sets"] as SaveProviderSettingsInput["sets"],
  }, { version: 1, sets: [] });
}

function environmentView(environment: NodeJS.ProcessEnv): EnvironmentProviderView {
  try {
    const runtime = loadRuntimeConfig(environment);
    const credentials = new EnvironmentCredentialSource(environment);
    const reasoning = loadReasoningConfiguration(runtime, environment);
    const task = loadTaskConfiguration(runtime, environment);
    const credentialConfigured = runtime.mode === "local" || credentials.get(runtime.credentialEnvironmentVariable) !== undefined;
    const providerName = runtime.mode === "free" ? "OpenCode Zen" : runtime.providerSelection.provider;
    return {
      available: credentialConfigured,
      mode: runtime.mode,
      label: runtime.mode === "free" ? "Free Mode" : "Environment fallback",
      provider: providerName,
      ...(runtime.providerSelection.model === undefined ? {} : { model: runtime.mode === "free" ? displayModelName(runtime.providerSelection.model) : runtime.providerSelection.model }),
      credentialConfigured,
      locked: true,
      roles: [...reasoning.assignments, ...task.assignments].map((assignment) => ({
        role: assignment.role,
        provider: runtime.mode === "free" ? providerName : assignment.providerId,
        model: runtime.mode === "free" ? displayModelName(assignment.modelId) : assignment.modelId,
      })),
      message: runtime.mode === "free"
        ? "Powered by Conclave. Free Mode uses external inference; selected repository excerpts may be sent to OpenCode Zen. Do not use it for confidential repositories unless you accept the provider's data handling terms. The host controls the current configured Free models and credential."
        : "Read-only fallback loaded from .env. Any active personal set takes priority.",
    };
  } catch (error) {
    return {
      available: false,
      mode: "demo",
      label: "Environment fallback",
      credentialConfigured: false,
      locked: true,
      roles: [],
      message: error instanceof Error ? error.message : "Environment provider configuration is unavailable.",
    };
  }
}

export class ProviderSettingsStore {
  readonly #filePath: string;
  readonly #environment: NodeJS.ProcessEnv;
  #queue: Promise<void> = Promise.resolve();

  public constructor(options: { readonly filePath?: string; readonly environment?: NodeJS.ProcessEnv } = {}) {
    this.#environment = options.environment ?? process.env;
    this.#filePath = resolve(options.filePath ?? settingsPath(this.#environment));
  }

  public async view(): Promise<ProviderSettingsView> {
    const stored = await this.#read();
    return {
      maximumSets: MAX_PROVIDER_SETS,
      ...(stored.activeSetId === undefined ? {} : { activeSetId: stored.activeSetId }),
      environment: environmentView(this.#environment),
      catalog: PROVIDER_CATALOG,
      sets: stored.sets.map((set) => ({
        id: set.id,
        name: set.name,
        providers: set.providers.map((connection) => ({
          id: connection.id,
          provider: connection.provider,
          model: connection.model,
          ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
          apiKeyConfigured: connection.apiKey !== undefined,
        })),
        roles: set.roles,
      })),
    };
  }

  public async save(input: SaveProviderSettingsInput): Promise<ProviderSettingsView> {
    return this.#enqueue(async () => {
      const previous = await this.#read();
      const next = validatedSettings(input, previous);
      await this.#write(next);
      return this.view();
    });
  }

  public async activeSet(): Promise<StoredProviderSet | undefined> {
    const stored = await this.#read();
    return stored.sets.find((set) => set.id === stored.activeSetId);
  }

  /** Resolves a personal credential internally without ever adding it to a browser-facing view. */
  public async catalogCredential(setId: string, connectionId: string, provider: ConfigurableProviderId): Promise<string | undefined> {
    const stored = await this.#read();
    const connection = stored.sets.find((set) => set.id === setId)?.providers.find((candidate) => candidate.id === connectionId);
    return connection?.provider === provider ? connection.apiKey : undefined;
  }

  public createId(prefix: "set" | "provider"): string {
    return `${prefix}-${randomUUID()}`;
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(operation, operation);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async #read(): Promise<StoredProviderSettings> {
    try {
      return parseStored(await readFile(this.#filePath, "utf8"));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1, sets: [] };
      throw error;
    }
  }

  async #write(value: StoredProviderSettings): Promise<void> {
    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#filePath);
    await chmod(this.#filePath, 0o600);
  }
}
