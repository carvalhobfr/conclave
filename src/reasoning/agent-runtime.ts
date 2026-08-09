import type { LlmProvider, TokenUsage } from "../domain/provider.js";
import type { ModelProfile, ModelRequirement } from "../domain/adaptive-reasoning.js";
import type { AgentAssignment, AgentRole, ReasoningLimits } from "../domain/reasoning.js";
import { approximateTokenCount } from "../retrieval/context-packer.js";
import { StructuredOutputError } from "./structured-outputs.js";
import { roleSystemPrompt } from "./role-prompts.js";
import { ModelSelector } from "./model-selector.js";
import { ProviderHealthTracker } from "../providers/provider-health.js";

export interface AgentCallRecord {
  readonly role: AgentRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly providerUsage?: TokenUsage;
  readonly latencyMs: number;
  readonly repaired: boolean;
  readonly selectionReason: string;
  readonly fallback: boolean;
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

export interface AgentExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly requirement?: ModelRequirement;
  readonly previousModels?: readonly string[];
}

function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

export class StructuredAgentRuntime {
  readonly #providers: ReadonlyMap<string, LlmProvider>;
  readonly #assignments: ReadonlyMap<AgentRole, AgentAssignment>;
  readonly #limits: ReasoningLimits;
  readonly #selector: ModelSelector;
  readonly #health: ProviderHealthTracker;

  public constructor(
    providers: ReadonlyMap<string, LlmProvider>,
    assignments: readonly AgentAssignment[],
    limits: ReasoningLimits,
    options: {
      readonly selector?: ModelSelector;
      readonly health?: ProviderHealthTracker;
      readonly profiles?: readonly ModelProfile[];
      readonly fallbackPolicy?: "disabled" | "configured";
    } = {},
  ) {
    this.#providers = providers;
    this.#assignments = new Map(assignments.map((assignment) => [assignment.role, assignment]));
    this.#limits = limits;
    this.#health = options.health ?? new ProviderHealthTracker();
    this.#selector = options.selector ?? new ModelSelector({
      profiles: options.profiles ?? assignments.map((assignment) => ({
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        capabilities: { reasoning: "medium", coding: "medium", speed: "medium", context: "medium" },
        costClass: "standard",
      })),
      explicitAssignments: assignments,
      ...(options.fallbackPolicy === undefined ? {} : { fallbackPolicy: options.fallbackPolicy }),
      health: this.#health,
    });
  }

  public hasAssignment(role: AgentRole): boolean {
    return this.#assignments.has(role);
  }

  public health(): readonly ReturnType<ProviderHealthTracker["get"]>[] {
    return this.#health.all();
  }

  public async execute<T>(
    role: AgentRole,
    userPrompt: string,
    validate: StructuredValidator<T>,
    callBudget = 1 + this.#limits.structuredOutputRepairAttempts,
    options: AgentExecutionOptions = {},
  ): Promise<AgentExecution<T>> {
    if (signalAborted(options.signal)) throw options.signal?.reason;
    const selection = this.#selector.select(role, options.requirement, options.previousModels);
    const assignment = selection?.assignment;
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
      const systemPrompt =
        repairReason === undefined
          ? roleSystemPrompt(role)
          : `${roleSystemPrompt(role)}\n\nThe previous output was invalid: ${repairReason}. Return a corrected JSON object only.`;
      const messages = [
        { role: "system" as const, content: systemPrompt },
        { role: "user" as const, content: userPrompt },
      ];
      const started = performance.now();
      let response;
      try {
        if (signalAborted(options.signal)) throw options.signal?.reason;
        response = await provider.generate({
          model: assignment.modelId,
          messages,
          maxOutputTokens: this.#limits.maxOutputTokensPerCall,
          temperature: 0,
          responseFormat: "json",
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        });
      } catch (error) {
        this.#health.record(assignment.providerId, assignment.modelId, false, Math.max(0, performance.now() - started));
        const message = error instanceof Error ? error.message : "unknown provider failure";
        throw new AgentExecutionError(`${role} provider failed: ${message}`, role, calls);
      }
      this.#health.record(assignment.providerId, assignment.modelId, true, Math.max(0, performance.now() - started));
      const record: AgentCallRecord = {
        role,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        approximateInputTokens: approximateTokenCount(Buffer.byteLength(messages.map((message) => message.content).join("\n"))),
        approximateOutputTokens: approximateTokenCount(Buffer.byteLength(response.text)),
        ...(response.usage === undefined ? {} : { providerUsage: response.usage }),
        latencyMs: Math.max(0, performance.now() - started),
        repaired: attempt > 0,
        selectionReason: selection?.reason ?? "explicit role assignment",
        fallback: selection?.fallback ?? false,
      };
      calls.push(record);
      try {
        return { output: validate(response.text), calls };
      } catch (error) {
        if (!(error instanceof StructuredOutputError)) {
          throw error;
        }
        repairReason = error.message;
        if (attempt + 1 >= attempts) {
          throw new AgentExecutionError(
            `${role} returned invalid structured output after ${String(attempts)} attempts: ${error.message}`,
            role,
            calls,
          );
        }
      }
    }
    throw new AgentExecutionError(`${role} did not produce output`, role, calls);
  }
}
