import type { GuidedProviderId } from "./config/provider-profiles.js";
import type { InterfaceLanguage } from "./config/user-preferences.js";

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

const GUIDES_EN: Readonly<Record<GuidedProviderId, ProviderSetupGuide>> = {
  "opencode-go": {
    label: "OpenCode Zen (Go)",
    summary: "One OpenAI-compatible endpoint for DeepSeek, Kimi, GLM, Qwen, and other hosted models.",
    keyHint: "Use an inference API key created in your OpenCode account.",
    billingHint: "Requests use that OpenCode account's credits and limits.",
    caution: "Model behaviour varies widely here; keep the baseline profile unless you have measured an alternative.",
    keyUrl: "https://opencode.ai/auth",
  },
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

const GUIDES_TRANSLATED: Readonly<Record<Exclude<InterfaceLanguage, "en">, Readonly<Record<GuidedProviderId, ProviderSetupGuide>>>> = {
  "pt-BR": {
    "opencode-go": {
      label: "OpenCode Zen (Go)",
      summary: "Um endpoint compatível com OpenAI para DeepSeek, Kimi, GLM, Qwen e outros modelos hospedados.",
      keyHint: "Use uma chave de API de inferência criada na sua conta OpenCode.",
      billingHint: "As chamadas usam os créditos e limites dessa conta OpenCode.",
      caution: "O comportamento varia muito entre modelos aqui; mantenha o perfil base a menos que você tenha medido uma alternativa.",
      keyUrl: "https://opencode.ai/auth",
    },
    openai: {
      label: "OpenAI Platform / Codex API",
      summary: "Acesso direto aos modelos GPT e Codex API por api.openai.com.",
      keyHint: "Use uma chave padrão da OpenAI Platform. A mesma chave pode chamar os modelos Codex API disponíveis.",
      billingHint: "O uso pertence ao projeto e à organização da OpenAI API associados à chave.",
      caution: "Não cole token OAuth ou de sessão do ChatGPT/Codex; o login da assinatura é separado da autenticação da API.",
      keyUrl: "https://platform.openai.com/api-keys",
    },
    openrouter: {
      label: "Chave da conta OpenRouter",
      summary: "Um endpoint compatível com OpenAI para modelos de vários providers.",
      keyHint: "Use uma chave de API de inferência criada na sua conta OpenRouter.",
      billingHint: "As chamadas usam créditos, limites de gasto e opções gratuitas dessa conta OpenRouter.",
      caution: "Chaves administrativas e assinaturas de outros produtos não são chaves de inferência do OpenRouter.",
      keyUrl: "https://openrouter.ai/settings/keys",
    },
    anthropic: {
      label: "Anthropic API",
      summary: "Acesso direto aos modelos Claude pela Anthropic Messages API.",
      keyHint: "Use uma chave padrão da Anthropic Console.",
      billingHint: "O uso pertence ao workspace da Anthropic associado à chave.",
      caution: "Uma assinatura do app Claude é separada da autenticação da Anthropic API.",
      keyUrl: "https://console.anthropic.com/settings/keys",
    },
  },
  "es-ES": {
    "opencode-go": {
      label: "OpenCode Zen (Go)",
      summary: "Un endpoint compatible con OpenAI para DeepSeek, Kimi, GLM, Qwen y otros modelos alojados.",
      keyHint: "Usa una clave de API de inferencia creada en tu cuenta de OpenCode.",
      billingHint: "Las solicitudes usan los créditos y límites de esa cuenta de OpenCode.",
      caution: "El comportamiento varía mucho entre modelos aquí; mantén el perfil base salvo que hayas medido una alternativa.",
      keyUrl: "https://opencode.ai/auth",
    },
    openai: {
      label: "OpenAI Platform / Codex API",
      summary: "Acceso directo a los modelos GPT y Codex API mediante api.openai.com.",
      keyHint: "Usa una clave estándar de OpenAI Platform. La misma clave puede llamar a los modelos Codex API disponibles.",
      billingHint: "El uso pertenece al proyecto y a la organización de OpenAI API asociados a la clave.",
      caution: "No pegues tokens OAuth o de sesión de ChatGPT/Codex; el inicio de sesión de la suscripción es independiente de la autenticación de la API.",
      keyUrl: "https://platform.openai.com/api-keys",
    },
    openrouter: {
      label: "Clave de la cuenta OpenRouter",
      summary: "Un endpoint compatible con OpenAI para modelos de varios proveedores.",
      keyHint: "Usa una clave de API de inferencia creada en tu cuenta OpenRouter.",
      billingHint: "Las solicitudes usan los créditos, límites de gasto y opciones gratuitas de esa cuenta OpenRouter.",
      caution: "Las claves administrativas y las suscripciones de otros productos no son claves de inferencia de OpenRouter.",
      keyUrl: "https://openrouter.ai/settings/keys",
    },
    anthropic: {
      label: "Anthropic API",
      summary: "Acceso directo a los modelos Claude mediante Anthropic Messages API.",
      keyHint: "Usa una clave estándar de Anthropic Console.",
      billingHint: "El uso pertenece al workspace de Anthropic asociado a la clave.",
      caution: "Una suscripción de la aplicación Claude es independiente de la autenticación de Anthropic API.",
      keyUrl: "https://console.anthropic.com/settings/keys",
    },
  },
};

const SETUP_COPY = {
  en: {
    subtitle: "Secure reasoning setup · deterministic validation stays local",
    credentialGuide: "Credential guide",
    key: "Key", usage: "Usage", create: "Create", note: "Note",
    complete: "Setup complete", provider: "Provider", model: "Model", reasoning: "Reasoning", config: "Config", credential: "Credential",
    saved: "saved locally · hidden · mode 600", notSaved: "not saved", next: "Next",
    local: "Validation remains local and deterministic. Provider-backed reasoning is opt-in.",
  },
  "pt-BR": {
    "opencode-go": {
      label: "OpenCode Zen (Go)",
      summary: "Um endpoint compatível com OpenAI para DeepSeek, Kimi, GLM, Qwen e outros modelos hospedados.",
      keyHint: "Use uma chave de API de inferência criada na sua conta OpenCode.",
      billingHint: "As chamadas usam os créditos e limites dessa conta OpenCode.",
      caution: "O comportamento varia muito entre modelos aqui; mantenha o perfil base a menos que você tenha medido uma alternativa.",
      keyUrl: "https://opencode.ai/auth",
    },
    subtitle: "Setup seguro de reasoning · validação determinística continua local",
    credentialGuide: "Guia da credencial",
    key: "Chave", usage: "Uso", create: "Criar", note: "Nota",
    complete: "Setup concluído", provider: "Provider", model: "Modelo", reasoning: "Reasoning", config: "Config", credential: "Credencial",
    saved: "salva localmente · oculta · modo 600", notSaved: "não salva", next: "Próximo passo",
    local: "A validação continua local e determinística. O reasoning via provider é opt-in.",
  },
  "es-ES": {
    subtitle: "Configuración segura de razonamiento · la validación determinista sigue siendo local",
    credentialGuide: "Guía de credenciales",
    key: "Clave", usage: "Uso", create: "Crear", note: "Nota",
    complete: "Configuración completada", provider: "Proveedor", model: "Modelo", reasoning: "Razonamiento", config: "Config", credential: "Credencial",
    saved: "guardada localmente · oculta · modo 600", notSaved: "no guardada", next: "Siguiente paso",
    local: "La validación sigue siendo local y determinista. El razonamiento mediante proveedor es opcional.",
  },
} as const;

function style(text: string, codes: readonly string[], color: boolean): string {
  return color ? `${codes.join("")}${text}${ANSI.reset}` : text;
}

export function terminalColorEnabled(
  environment: NodeJS.ProcessEnv = process.env,
  terminal: boolean = process.stdout.isTTY,
): boolean {
  return terminal && environment["NO_COLOR"] === undefined && environment["TERM"] !== "dumb";
}

export function providerSetupGuide(provider: GuidedProviderId, language: InterfaceLanguage = "en"): ProviderSetupGuide {
  return language === "en" ? GUIDES_EN[provider] : GUIDES_TRANSLATED[language][provider];
}

export function renderSetupBanner(color: boolean, language: InterfaceLanguage = "en"): string {
  const copy = SETUP_COPY[language];
  const brand = style("◈ CONCLAVE", [ANSI.bold, ANSI.magenta], color);
  const subtitle = style(copy.subtitle, [ANSI.dim], color);
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

export function renderProviderGuide(provider: GuidedProviderId, color: boolean, language: InterfaceLanguage = "en"): string {
  const guide = providerSetupGuide(provider, language);
  const copy = SETUP_COPY[language];
  return [
    `\n${style(copy.credentialGuide, [ANSI.bold, ANSI.magenta], color)}`,
    `  ${style(guide.label, [ANSI.bold], color)} · ${guide.summary}`,
    `  ${style(copy.key, [ANSI.cyan], color)}      ${guide.keyHint}`,
    `  ${style(copy.usage, [ANSI.cyan], color)}    ${guide.billingHint}`,
    `  ${style(copy.create, [ANSI.cyan], color)}   ${guide.keyUrl}`,
    `  ${style(copy.note, [ANSI.yellow], color)}     ${guide.caution}`,
  ].join("\n");
}

export function renderSetupSuccess(report: SetupSummary, color: boolean, language: InterfaceLanguage = "en"): string {
  const copy = SETUP_COPY[language];
  const saved = report.credentialSaved
    ? style(copy.saved, [ANSI.green], color)
    : style(copy.notSaved, [ANSI.yellow], color);
  return [
    "",
    style(`╭─ ${copy.complete} ───────────────────────────────────────────`, [ANSI.green], color),
    `│  ${style(copy.provider, [ANSI.dim], color)}    ${report.provider}`,
    `│  ${style(copy.model, [ANSI.dim], color)}       ${report.model}`,
    `│  ${style(copy.reasoning, [ANSI.dim], color)}   ${report.reasoningPreset}`,
    `│  ${style(copy.config, [ANSI.dim], color)}      ${report.configFile}`,
    `│  ${style(copy.credential, [ANSI.dim], color)}  ${saved}`,
    style("╰────────────────────────────────────────────────────────────", [ANSI.green], color),
    `${style(copy.next, [ANSI.bold, ANSI.cyan], color)}  ${report.next}`,
    style(copy.local, [ANSI.dim], color),
  ].join("\n");
}
