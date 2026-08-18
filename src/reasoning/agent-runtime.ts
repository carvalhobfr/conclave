import type { LlmProvider, TokenUsage } from "../domain/provider.js";
import type { AgentAssignment, AgentRole, ReasoningLimits } from "../domain/reasoning.js";
import { approximateTokenCount } from "../retrieval/context-packer.js";
import { StructuredOutputError } from "./structured-outputs.js";
import { ROLE_OUTPUT_JSON_SCHEMAS, roleSystemPrompt } from "./role-prompts.js";

export interface AgentCallRecord {
  readonly role: AgentRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly providerUsage?: TokenUsage;
  readonly latencyMs: number;
  readonly repaired: boolean;
  readonly failed: boolean;
}

export interface AgentExecution<T> {
  readonly output: T;
  readonly calls: readonly AgentCallRecord[];
}

export class AgentExecutionError extends Error {
  public readonly role: AgentRole;
  public readonly calls: readonly AgentCallRecord[];

  public constructor(message: string, role: AgentRole, calls: readonly AgentCallRecord[] = []) {
    super(message);
    this.name = "AgentExecutionError";
    this.role = role;
    this.calls = calls;
  }
}

export type StructuredValidator<T> = (raw: string) => T;

export class StructuredAgentRuntime {
  readonly #providers: ReadonlyMap<string, LlmProvider>;
  readonly #assignments: ReadonlyMap<AgentRole, AgentAssignment>;
  readonly #limits: ReasoningLimits;

  public constructor(
    providers: ReadonlyMap<string, LlmProvider>,
    assignments: readonly AgentAssignment[],
    limits: ReasoningLimits,
  ) {
    this.#providers = providers;
    this.#assignments = new Map(assignments.map((assignment) => [assignment.role, assignment]));
    this.#limits = limits;
  }

  public async execute<T>(
    role: AgentRole,
    userPrompt: string,
    validate: StructuredValidator<T>,
    callBudget = 1 + this.#limits.structuredOutputRepairAttempts,
  ): Promise<AgentExecution<T>> {
    const assignment = this.#assignments.get(role);
    if (assignment === undefined) {
      throw new AgentExecutionError(`No assignment configured for ${role}`, role);
    }
    const provider = this.#providers.get(assignment.providerId);
    if (provider === undefined) {
      throw new AgentExecutionError(
        `Provider ${assignment.providerId} is not registered for ${role}`,
        role,
      );
    }
    const calls: AgentCallRecord[] = [];
    let repairReason: string | undefined;
    const attempts = Math.min(1 + this.#limits.structuredOutputRepairAttempts, callBudget);
    if (attempts < 1) {
      throw new AgentExecutionError(`No model-call budget remains for ${role}`, role);
    }
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (calls.length >= callBudget) break;
      const systemPrompt =
        repairReason === undefined
          ? roleSystemPrompt(role)
          : `${roleSystemPrompt(role)}\n\nThe previous output was invalid: ${repairReason}. Return a corrected JSON object only.`;
      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ];
      const preferredModel = repairReason === undefined || assignment.fallbackModelId === undefined
        ? assignment.modelId
        : assignment.fallbackModelId;
      const alternateModel = preferredModel === assignment.modelId
        ? assignment.fallbackModelId
        : assignment.modelId;
      const modelCandidates = alternateModel === undefined
        ? [preferredModel]
        : [preferredModel, alternateModel];
      let response;
      let selectedModel = preferredModel;
      let lastFailure = "unknown provider failure";
      for (const modelId of modelCandidates) {
        if (calls.length >= callBudget) break;
        selectedModel = modelId;
        const started = performance.now();
        try {
          response = await provider.generate({
            model: modelId,
            messages,
            maxOutputTokens: this.#limits.maxOutputTokensPerCall,
            temperature: 0,
            responseFormat: "json",
            responseSchema: ROLE_OUTPUT_JSON_SCHEMAS[role],
          });
          calls.push({
            role,
            providerId: assignment.providerId,
            modelId,
            approximateInputTokens: approximateTokenCount(Buffer.byteLength(messages.map((message) => message.content).join("\n"))),
            approximateOutputTokens: approximateTokenCount(Buffer.byteLength(response.text)),
            ...(response.usage === undefined ? {} : { providerUsage: response.usage }),
            latencyMs: Math.max(0, performance.now() - started),
            repaired: attempt > 0,
            failed: false,
          });
          break;
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : "unknown provider failure";
          calls.push({
            role,
            providerId: assignment.providerId,
            modelId,
            approximateInputTokens: approximateTokenCount(Buffer.byteLength(messages.map((message) => message.content).join("\n"))),
            approximateOutputTokens: 0,
            latencyMs: Math.max(0, performance.now() - started),
            repaired: attempt > 0,
            failed: true,
          });
        }
      }
      if (response === undefined) {
        throw new AgentExecutionError(`${role} provider failed: ${lastFailure}`, role, calls);
      }
      try {
        return { output: validate(response.text), calls };
      } catch (error) {
        if (!(error instanceof StructuredOutputError)) {
          throw error;
        }
        repairReason = error.message;
        if (attempt + 1 >= attempts) {
          throw new AgentExecutionError(
            `${role} returned invalid structured output from ${selectedModel} after ${String(calls.length)} calls: ${error.message}`,
            role,
            calls,
          );
        }
      }
    }
    throw new AgentExecutionError(`${role} did not produce output`, role, calls);
  }
}
