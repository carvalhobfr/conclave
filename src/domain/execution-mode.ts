import type { PrivacyBoundary } from "./security.js";
import type { ProviderId } from "./provider.js";

export type ExecutionMode = "free" | "api" | "local";

interface ProviderSelection {
  readonly provider: Exclude<ProviderId, "fake">;
  readonly model?: string;
  readonly baseUrl?: string;
}

export interface FreeModeConfig {
  readonly mode: "free";
  readonly privacyBoundary: "external";
  readonly credentialEnvironmentVariable: "CONCLAVE_FREE_API_KEY";
  readonly allowedModels: readonly string[];
  readonly providerTimeoutMs?: number;
  readonly providerSelection: ProviderSelection;
}

export interface ApiModeConfig {
  readonly mode: "api";
  readonly privacyBoundary: "external";
  readonly credentialEnvironmentVariable: "CONCLAVE_API_KEY";
  readonly providerTimeoutMs?: number;
  readonly providerSelection: ProviderSelection;
}

export interface LocalModeConfig {
  readonly mode: "local";
  readonly privacyBoundary: "local-only";
  readonly providerTimeoutMs?: number;
  readonly providerSelection: ProviderSelection;
}

export type RuntimeConfig = FreeModeConfig | ApiModeConfig | LocalModeConfig;

export interface PublicRuntimeConfig {
  readonly mode: ExecutionMode;
  readonly privacyBoundary: PrivacyBoundary;
  readonly provider: Exclude<ProviderId, "fake">;
  readonly modelConfigured: boolean;
  readonly baseUrl?: string;
  readonly credentialSource: "server-environment" | "user-environment" | "not-required";
  readonly credentialConfigured: boolean;
}
