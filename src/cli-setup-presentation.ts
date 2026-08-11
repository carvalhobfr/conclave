import type { GuidedProviderId } from "./config/provider-profiles.js";

export interface ProviderSetupGuide {
  readonly label: string;
  readonly summary: string;
  readonly keyHint: string;
  readonly billingHint: string;
  readonly caution: string;
  readonly keyUrl: string;
}

interface SetupSummary {
  readonly configFile: string;
  readonly provider: GuidedProviderId;
  readonly model: string;
  readonly reasoningPreset: string;
  readonly credentialSaved: boolean;
  readonly next: string;
}

const ANSI = {
  reset: "\u001B[0m",
  bold: "\u001B[1m",
  dim: "\u001B[2m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  magenta: "\u001B[35m",
  cyan: "\u001B[36m",
} as const;

const GUIDES: Readonly<Record<GuidedProviderId, ProviderSetupGuide>> = {
  openai: {
    label: "OpenAI Platform / Codex API",
    summary: "Direct access to GPT and Codex API models through api.openai.com.",
    keyHint: "Use a standard OpenAI Platform API key. The same key can call available Codex API models.",
    billingHint: "Usage belongs to the OpenAI API project and organization attached to the key.",
    caution: "Do not paste a ChatGPT/Codex OAuth or session token; subscription sign-in is separate from API authentication.",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    label: "OpenRouter account key",
    summary: "One OpenAI-compatible endpoint for models from multiple providers.",
    keyHint: "Use an inference API key created in your OpenRouter account.",
    billingHint: "Requests use that account's OpenRouter credits, spending limits, and free-model allowance.",
    caution: "Management keys and subscriptions from other products are not OpenRouter inference keys.",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  anthropic: {
    label: "Anthropic API",
    summary: "Direct access to Claude models through the Anthropic Messages API.",
    keyHint: "Use a standard Anthropic Console API key.",
    billingHint: "Usage belongs to the Anthropic workspace attached to the key.",
    caution: "A Claude app subscription is separate from Anthropic API authentication.",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
};

function style(text: string, codes: readonly string[], color: boolean): string {
  return color ? `${codes.join("")}${text}${ANSI.reset}` : text;
}

export function terminalColorEnabled(
  environment: NodeJS.ProcessEnv = process.env,
  terminal: boolean = process.stdout.isTTY,
): boolean {
  return terminal && environment["NO_COLOR"] === undefined && environment["TERM"] !== "dumb";
}

export function providerSetupGuide(provider: GuidedProviderId): ProviderSetupGuide {
  return GUIDES[provider];
}

export function renderSetupBanner(color: boolean): string {
  const brand = style("◈ CONCLAVE", [ANSI.bold, ANSI.magenta], color);
  const subtitle = style("Secure reasoning setup · deterministic validation stays local", [ANSI.dim], color);
  return [
    "╭────────────────────────────────────────────────────────────",
    `│  ${brand}`,
    `│  ${subtitle}`,
    "╰────────────────────────────────────────────────────────────",
  ].join("\n");
}

export function renderSetupStep(
  current: number,
  total: number,
  title: string,
  description: string,
  color: boolean,
): string {
  const step = style(`[${String(current)}/${String(total)}]`, [ANSI.bold, ANSI.cyan], color);
  const heading = style(title, [ANSI.bold], color);
  return `\n${step} ${heading}\n${style(description, [ANSI.dim], color)}`;
}

export function renderSetupChoice(
  index: number,
  choice: { readonly id: string; readonly label: string; readonly description: string },
  color: boolean,
): string {
  const number = style(String(index), [ANSI.bold, ANSI.magenta], color);
  const label = style(choice.label, [ANSI.bold], color);
  const id = style(choice.id, [ANSI.cyan], color);
  return `  ${number}  ${label} ${style(`(${id})`, [ANSI.dim], color)}\n     ${style(choice.description, [ANSI.dim], color)}`;
}

export function renderProviderGuide(provider: GuidedProviderId, color: boolean): string {
  const guide = providerSetupGuide(provider);
  return [
    `\n${style("Credential guide", [ANSI.bold, ANSI.magenta], color)}`,
    `  ${style(guide.label, [ANSI.bold], color)} · ${guide.summary}`,
    `  ${style("Key", [ANSI.cyan], color)}      ${guide.keyHint}`,
    `  ${style("Usage", [ANSI.cyan], color)}    ${guide.billingHint}`,
    `  ${style("Create", [ANSI.cyan], color)}   ${guide.keyUrl}`,
    `  ${style("Note", [ANSI.yellow], color)}     ${guide.caution}`,
  ].join("\n");
}

export function renderSetupSuccess(report: SetupSummary, color: boolean): string {
  const saved = report.credentialSaved
    ? style("saved locally · hidden · mode 600", [ANSI.green], color)
    : style("not saved", [ANSI.yellow], color);
  return [
    "",
    style("╭─ Setup complete ───────────────────────────────────────────", [ANSI.green], color),
    `│  ${style("Provider", [ANSI.dim], color)}    ${report.provider}`,
    `│  ${style("Model", [ANSI.dim], color)}       ${report.model}`,
    `│  ${style("Reasoning", [ANSI.dim], color)}   ${report.reasoningPreset}`,
    `│  ${style("Config", [ANSI.dim], color)}      ${report.configFile}`,
    `│  ${style("Credential", [ANSI.dim], color)}  ${saved}`,
    style("╰────────────────────────────────────────────────────────────", [ANSI.green], color),
    `${style("Next", [ANSI.bold, ANSI.cyan], color)}  ${report.next}`,
    style("Validation remains local and deterministic. Provider-backed reasoning is opt-in.", [ANSI.dim], color),
  ].join("\n");
}
