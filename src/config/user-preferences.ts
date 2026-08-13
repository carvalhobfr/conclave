import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";

export const INTERFACE_LANGUAGES = ["en", "pt-BR", "es-ES"] as const;

export type InterfaceLanguage = (typeof INTERFACE_LANGUAGES)[number];

export interface UserPreferences {
  readonly schemaVersion: 1;
  readonly language: InterfaceLanguage;
}

export interface LoadedUserPreferences {
  readonly path: string;
  readonly exists: boolean;
  readonly preferences: UserPreferences;
}

const DEFAULT_PREFERENCES: UserPreferences = {
  schemaVersion: 1,
  language: "en",
};

const LANGUAGE_ALIASES: Readonly<Record<string, InterfaceLanguage>> = {
  en: "en",
  "en-gb": "en",
  "en-us": "en",
  pt: "pt-BR",
  "pt-br": "pt-BR",
  "pt_br": "pt-BR",
  es: "es-ES",
  "es-es": "es-ES",
  "es_es": "es-ES",
};

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export function parseInterfaceLanguage(value: string): InterfaceLanguage {
  const language = LANGUAGE_ALIASES[value.trim().toLowerCase()];
  if (language === undefined) {
    throw new Error(`Unsupported interface language: ${value}. Use en, pt-BR, or es-ES.`);
  }
  return language;
}

export function userPreferencesPath(
  environment: NodeJS.ProcessEnv = process.env,
  userHome = homedir(),
  platform = process.platform,
): string {
  const explicit = environment["CONCLAVE_CONFIG_HOME"]?.trim();
  if (explicit !== undefined && explicit !== "") return resolve(explicit, "config.json");
  const xdg = environment["XDG_CONFIG_HOME"]?.trim();
  if (xdg !== undefined && xdg !== "") return resolve(xdg, "conclave", "config.json");
  const appData = environment["APPDATA"]?.trim();
  if (platform === "win32" && appData !== undefined && appData !== "") {
    return resolve(appData, "Conclave", "config.json");
  }
  return join(userHome, ".config", "conclave", "config.json");
}

function parsePreferences(value: unknown, path: string): UserPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid Conclave preferences in ${path}: expected a JSON object.`);
  }
  const object = value as Record<string, unknown>;
  if (object["schemaVersion"] !== 1 || typeof object["language"] !== "string") {
    throw new Error(`Invalid Conclave preferences in ${path}: expected schemaVersion 1 and a language.`);
  }
  return { schemaVersion: 1, language: parseInterfaceLanguage(object["language"]) };
}

export async function loadUserPreferences(
  path = userPreferencesPath(),
): Promise<LoadedUserPreferences> {
  const resolvedPath = resolve(path);
  let contents: string;
  try {
    contents = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if (isMissingFile(error)) {
      return { path: resolvedPath, exists: false, preferences: DEFAULT_PREFERENCES };
    }
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch (error) {
    throw new Error(`Invalid JSON in Conclave preferences: ${resolvedPath}`, { cause: error });
  }
  return { path: resolvedPath, exists: true, preferences: parsePreferences(value, resolvedPath) };
}

export async function saveUserPreferences(
  preferences: UserPreferences,
  path = userPreferencesPath(),
): Promise<string> {
  const resolvedPath = resolve(path);
  const directory = dirname(resolvedPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = `${resolvedPath}.${String(process.pid)}.tmp`;
  const contents = `${JSON.stringify(preferences, undefined, 2)}\n`;
  await writeFile(temporaryPath, contents, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, resolvedPath);
  await chmod(resolvedPath, 0o600);
  return resolvedPath;
}

export async function setInterfaceLanguage(
  language: InterfaceLanguage,
  path = userPreferencesPath(),
): Promise<LoadedUserPreferences> {
  const preferences: UserPreferences = { schemaVersion: 1, language };
  const savedPath = await saveUserPreferences(preferences, path);
  return { path: savedPath, exists: true, preferences };
}

export function languageFromEnvironment(
  fallback: InterfaceLanguage,
  environment: NodeJS.ProcessEnv = process.env,
  preferenceExists = false,
): { readonly language: InterfaceLanguage; readonly source: "environment" | "preferences" | "default" } {
  const requested = environment["CONCLAVE_LANGUAGE"]?.trim();
  if (requested !== undefined && requested !== "") {
    return { language: parseInterfaceLanguage(requested), source: "environment" };
  }
  return { language: fallback, source: preferenceExists ? "preferences" : "default" };
}
