import type { ReasoningPreset } from "../domain/reasoning.js";
import {
  providerProfile,
  type GuidedProviderId,
  reasoningStyle,
} from "./provider-profiles.js";

export interface SetupSelection {
  readonly provider: GuidedProviderId;
  readonly profileId?: string;
  readonly model?: string;
  readonly reasoningStyleId?: string;
  readonly apiKey?: string;
}

export interface SetupConfiguration {
  readonly environment: Readonly<Record<string, string>>;
  readonly provider: GuidedProviderId;
  readonly model: string;
  readonly reasoningPreset: Exclude<ReasoningPreset, "local">;
  readonly credentialSaved: boolean;
}

function requireSingleLine(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${label} cannot be empty`);
  if (trimmed.includes("\u0000") || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error(`${label} must be a single line`);
  }
  return trimmed;
}

export function createSetupConfiguration(selection: SetupSelection): SetupConfiguration {
  const profile = providerProfile(selection.provider, selection.profileId);
  const style = reasoningStyle(selection.reasoningStyleId);
  const model = selection.model === undefined
    ? profile.model
    : requireSingleLine(selection.model, "Model");
  const apiKey = selection.apiKey === undefined ? undefined : requireSingleLine(selection.apiKey, "API key");
  return {
    environment: {
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: selection.provider,
      CONCLAVE_MODEL: model,
      CONCLAVE_REASONING_PRESET: style.preset,
      ...(apiKey === undefined ? {} : { CONCLAVE_API_KEY: apiKey }),
    },
    provider: selection.provider,
    model,
    reasoningPreset: style.preset,
    credentialSaved: apiKey !== undefined,
  };
}
