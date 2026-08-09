import type {
  ProviderModelProfileView,
  ProviderModelsView,
  ProviderModelView,
  ProviderRole,
  ProviderRoleAssignmentView,
} from "./contracts.js";

const MAX_CATALOG_BYTES = 3_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
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

type CatalogProvider = ProviderModelsView["provider"];
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface CatalogModel extends ProviderModelView {
  readonly promptPrice?: number;
  readonly outputPrice?: number;
}

export class ProviderModelCatalogError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ProviderModelCatalogError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim() === "") return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function displayName(id: string): string {
  return id.split("/").at(-1)?.replaceAll("-", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) ?? id;
}

function isOpenAiTextModel(id: string): boolean {
  const normalized = id.toLowerCase();
  if (!/^(gpt-|chatgpt-|o[134](?:-|$))/.test(normalized)) return false;
  return !/(audio|embedding|image|moderation|realtime|search|transcri|tts|vision-preview)/.test(normalized);
}

function versionScore(id: string): number {
  const match = /(?:gpt-|^o)(\d+)(?:\.(\d+))?/.exec(id.toLowerCase());
  if (match === null) return 0;
  return Number(match[1] ?? 0) * 1_000 + Number(match[2] ?? 0);
}

function variantScore(id: string): number {
  if (/(?:^|-)pro(?:-|$)/i.test(id)) return 3;
  if (/(?:^|-)(?:max|ultra)(?:-|$)/i.test(id)) return 2;
  return 0;
}

function newest(models: readonly CatalogModel[], predicate: (model: CatalogModel) => boolean): CatalogModel | undefined {
  return [...models].filter(predicate).sort((left, right) => {
    const version = versionScore(right.id) - versionScore(left.id);
    if (version !== 0) return version;
    const variant = variantScore(right.id) - variantScore(left.id);
    if (variant !== 0) return variant;
    const leftSnapshot = /-\d{4}-\d{2}-\d{2}$/.test(left.id) ? 1 : 0;
    const rightSnapshot = /-\d{4}-\d{2}-\d{2}$/.test(right.id) ? 1 : 0;
    return leftSnapshot - rightSnapshot || left.id.localeCompare(right.id);
  })[0];
}

function cheapest(models: readonly CatalogModel[]): CatalogModel | undefined {
  const priced = models.filter((model) => model.promptPrice !== undefined || model.outputPrice !== undefined);
  return [...priced].sort((left, right) => {
    const leftPrice = (left.promptPrice ?? 0) + (left.outputPrice ?? 0);
    const rightPrice = (right.promptPrice ?? 0) + (right.outputPrice ?? 0);
    return leftPrice - rightPrice || left.id.localeCompare(right.id);
  })[0];
}

function assignment(connectionId: string, role: ProviderRole, model: CatalogModel): ProviderRoleAssignmentView {
  return { role, connectionId, model: model.id };
}

function profile(
  id: ProviderModelProfileView["id"],
  name: string,
  description: string,
  connectionId: string,
  general: CatalogModel,
  critical: CatalogModel,
  coding: CatalogModel,
): ProviderModelProfileView {
  const assignments = ROLES.map((role) => {
    const model = role === "implementer"
      ? coding
      : new Set<ProviderRole>(["skeptic", "architect", "verifier", "judge", "planner"]).has(role)
        ? critical
        : general;
    return assignment(connectionId, role, model);
  });
  return { id, name, description, defaultModel: general.id, assignments };
}

function profiles(provider: CatalogProvider, models: readonly CatalogModel[], connectionId: string): readonly ProviderModelProfileView[] {
  const fallback = models[0];
  if (fallback === undefined) return [];
  const quality = provider === "openai"
    ? newest(models, (model) => !/(mini|nano|codex|chat|preview)/i.test(model.id)) ?? fallback
    : fallback;
  const economy = provider === "openai"
    ? newest(models, (model) => /mini/i.test(model.id)) ?? newest(models, (model) => /nano/i.test(model.id)) ?? fallback
    : cheapest(models) ?? models.find((model) => /(:free|-free$)/i.test(model.id)) ?? fallback;
  const coding = newest(models, (model) => /(codex|coder|code)/i.test(model.id)) ?? quality;

  return [
    profile("balanced", "Balanced", "Stronger models for decisions and a coding model for implementation.", connectionId, economy, quality, coding),
    profile("quality", "Maximum quality", "Uses the strongest available model, with a coding specialist when available.", connectionId, quality, quality, coding),
    profile("economy", "Economy", "Uses the lowest-cost suitable model for every role.", connectionId, economy, economy, economy),
  ];
}

function parseOpenAi(payload: unknown): readonly CatalogModel[] {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) throw new ProviderModelCatalogError("OpenAI returned an unexpected model catalog.");
  const unique = new Map<string, CatalogModel>();
  for (const value of payload["data"]) {
    if (!isRecord(value)) continue;
    const id = nonEmptyString(value["id"]);
    if (id === undefined || !isOpenAiTextModel(id)) continue;
    unique.set(id, { id, name: displayName(id) });
  }
  return [...unique.values()].sort((left, right) => {
    const score = versionScore(right.id) - versionScore(left.id);
    return score || left.id.localeCompare(right.id);
  });
}

function parseOpenRouter(payload: unknown): readonly CatalogModel[] {
  if (!isRecord(payload) || !Array.isArray(payload["data"])) throw new ProviderModelCatalogError("OpenRouter returned an unexpected model catalog.");
  const unique = new Map<string, CatalogModel>();
  for (const value of payload["data"]) {
    if (!isRecord(value)) continue;
    const id = nonEmptyString(value["id"]);
    if (id === undefined) continue;
    const architecture = isRecord(value["architecture"]) ? value["architecture"] : undefined;
    const outputModalities = architecture !== undefined && Array.isArray(architecture["output_modalities"])
      ? architecture["output_modalities"]
      : undefined;
    if (outputModalities !== undefined && !outputModalities.includes("text")) continue;
    const pricing = isRecord(value["pricing"]) ? value["pricing"] : undefined;
    const contextLength = finiteNumber(value["context_length"]);
    const promptPrice = pricing === undefined ? undefined : finiteNumber(pricing["prompt"]);
    const outputPrice = pricing === undefined ? undefined : finiteNumber(pricing["completion"]);
    unique.set(id, {
      id,
      name: nonEmptyString(value["name"]) ?? displayName(id),
      ...(contextLength === undefined ? {} : { contextLength }),
      ...(promptPrice === undefined ? {} : { promptPrice }),
      ...(outputPrice === undefined ? {} : { outputPrice }),
    });
  }
  return [...unique.values()];
}

async function responsePayload(response: Response, provider: CatalogProvider): Promise<unknown> {
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new ProviderModelCatalogError(`The personal ${provider === "openai" ? "OpenAI" : "OpenRouter"} key was not accepted.`);
    if (response.status === 429) throw new ProviderModelCatalogError(`${provider === "openai" ? "OpenAI" : "OpenRouter"} rate-limited the model catalog request.`);
    throw new ProviderModelCatalogError(`${provider === "openai" ? "OpenAI" : "OpenRouter"} could not load the model catalog.`);
  }
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_CATALOG_BYTES) throw new ProviderModelCatalogError("The provider model catalog is too large.");
  const content = await response.text();
  if (Buffer.byteLength(content) > MAX_CATALOG_BYTES) throw new ProviderModelCatalogError("The provider model catalog is too large.");
  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new ProviderModelCatalogError("The provider returned an invalid model catalog.");
  }
}

export class ProviderModelCatalog {
  readonly #fetch: Fetcher;

  public constructor(fetcher: Fetcher = globalThis.fetch) {
    this.#fetch = fetcher;
  }

  public async list(provider: CatalogProvider, apiKey: string, connectionId: string): Promise<ProviderModelsView> {
    const key = apiKey.trim();
    if (key === "" || key.length > 4096) throw new ProviderModelCatalogError("Enter a valid personal API key to load models.");
    const url = provider === "openai"
      ? "https://api.openai.com/v1/models"
      : "https://openrouter.ai/api/v1/models/user?output_modalities=text&sort=intelligence-high-to-low";
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ProviderModelCatalogError(`Could not connect to ${provider === "openai" ? "OpenAI" : "OpenRouter"} to load models.`);
    }
    const models = provider === "openai"
      ? parseOpenAi(await responsePayload(response, provider))
      : parseOpenRouter(await responsePayload(response, provider));
    if (models.length === 0) throw new ProviderModelCatalogError("No compatible text models were returned for this personal key.");
    return {
      provider,
      models: models.map(({ id, name, contextLength }) => ({ id, name, ...(contextLength === undefined ? {} : { contextLength }) })),
      profiles: profiles(provider, models, connectionId),
    };
  }
}
