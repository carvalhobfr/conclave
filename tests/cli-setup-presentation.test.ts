import { describe, expect, it } from "vitest";

import {
  providerSetupGuide,
  renderProviderGuide,
  renderSetupBanner,
  renderSetupSuccess,
  terminalColorEnabled,
} from "../src/cli-setup-presentation.js";

describe("CLI setup presentation", () => {
  it("distinguishes OpenAI API and Codex project keys from subscription sign-in", () => {
    const guide = providerSetupGuide("openai");

    expect(guide.label).toContain("Codex API");
    expect(guide.keyHint).toContain("standard OpenAI Platform API key");
    expect(guide.caution).toContain("OAuth or session token");
    expect(renderProviderGuide("openai", false)).toContain("https://platform.openai.com/api-keys");
  });

  it("explains that OpenRouter usage follows the key owner's credits and limits", () => {
    const guide = providerSetupGuide("openrouter");

    expect(guide.billingHint).toContain("OpenRouter credits");
    expect(guide.billingHint).toContain("spending limits");
    expect(guide.caution).toContain("subscriptions from other products");
    expect(renderProviderGuide("openrouter", false)).toContain("https://openrouter.ai/settings/keys");
  });

  it("uses color only for an eligible terminal", () => {
    expect(terminalColorEnabled({}, true)).toBe(true);
    expect(terminalColorEnabled({ NO_COLOR: "1" }, true)).toBe(false);
    expect(terminalColorEnabled({ TERM: "dumb" }, true)).toBe(false);
    expect(terminalColorEnabled({}, false)).toBe(false);
    expect(renderSetupBanner(false)).not.toContain("\u001B[");
    expect(renderSetupBanner(true)).toContain("\u001B[");
  });

  it("renders a modern summary without accepting or exposing a credential value", () => {
    const rendered = renderSetupSuccess({
      configFile: "/project/.env",
      provider: "openrouter",
      model: "openrouter/free",
      reasoningPreset: "free-like",
      credentialSaved: true,
      next: "Run `conclave provider-check`.",
    }, false);

    expect(rendered).toContain("Setup complete");
    expect(rendered).toContain("saved locally · hidden · mode 600");
    expect(rendered).not.toContain("API_KEY");
  });
});
