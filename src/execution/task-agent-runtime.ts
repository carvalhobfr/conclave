import type { LlmProvider, TokenUsage } from "../domain/provider.js";
import type {
  TaskAgentAssignment,
  TaskAgentRole,
  TaskExecutionLimits,
} from "../domain/task-execution.js";
import { approximateTokenCount } from "../retrieval/context-packer.js";
import { StructuredOutputError } from "../reasoning/structured-outputs.js";
import { taskRoleSystemPrompt } from "./task-prompts.js";

export interface TaskAgentCallRecord {
  readonly role: TaskAgentRole;
  readonly providerId: string;
  readonly modelId: string;
  readonly approximateInputTokens: number;
  readonly approximateOutputTokens: number;
  readonly providerUsage?: TokenUsage;
  readonly latencyMs: number;
  readonly repaired: boolean;
}

export interface TaskAgentExecution<T> {
  readonly output: T;
  readonly calls: readonly TaskAgentCallRecord[];
}

export class TaskAgentExecutionError extends Error {
  public readonly role: TaskAgentRole;
  public readonly calls: readonly TaskAgentCallRecord[];

  public constructor(message: string, role: TaskAgentRole, calls: readonly TaskAgentCallRecord[] = []) {
    super(message);
    this.name = "TaskAgentExecutionError";
    this.role = role;
    this.calls = calls;
  }
}

export class StructuredTaskAgentRuntime {
  readonly #providers: ReadonlyMap<string, LlmProvider>;
  readonly #assignments: ReadonlyMap<TaskAgentRole, TaskAgentAssignment>;
  readonly #limits: TaskExecutionLimits;

  public constructor(
    providers: ReadonlyMap<string, LlmProvider>,
    assignments: readonly TaskAgentAssignment[],
    limits: TaskExecutionLimits,
  ) {
    this.#providers = providers;
    this.#assignments = new Map(assignments.map((assignment) => [assignment.role, assignment]));
    this.#limits = limits;
  }

  public async execute<T>(
    role: TaskAgentRole,
    prompt: string,
    validate: (raw: string) => T,
    callBudget: number,
  ): Promise<TaskAgentExecution<T>> {
    const assignment = this.#assignments.get(role);
    if (assignment === undefined) throw new TaskAgentExecutionError(`No assignment configured for ${role}`, role);
    const provider = this.#providers.get(assignment.providerId);
    if (provider === undefined) {
      throw new TaskAgentExecutionError(`Provider ${assignment.providerId} is not registered for ${role}`, role);
    }
    const attempts = Math.min(2, callBudget);
    if (attempts < 1) throw new TaskAgentExecutionError(`No task model-call budget remains for ${role}`, role);
    const calls: TaskAgentCallRecord[] = [];
    let repairReason: string | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const system =
        repairReason === undefined
          ? taskRoleSystemPrompt(role)
          : `${taskRoleSystemPrompt(role)}\n\nPrevious output was invalid: ${repairReason}. Return corrected JSON only.`;
      const messages = [
        { role: "system" as const, content: system },
        { role: "user" as const, content: prompt },
      ];
      const started = performance.now();
      let response;
      try {
        response = await provider.generate({
          model: assignment.modelId,
          messages,
          maxOutputTokens: this.#limits.maxOutputTokensPerCall,
          temperature: 0,
          responseFormat: "json",
        });
      } catch (error) {
        throw new TaskAgentExecutionError(
          `${role} provider failed: ${error instanceof Error ? error.message : "unknown provider failure"}`,
          role,
          calls,
        );
      }
      calls.push({
        role,
        providerId: assignment.providerId,
        modelId: assignment.modelId,
        approximateInputTokens: approximateTokenCount(
          Buffer.byteLength(messages.map((message) => message.content).join("\n")),
        ),
        approximateOutputTokens: approximateTokenCount(Buffer.byteLength(response.text)),
        ...(response.usage === undefined ? {} : { providerUsage: response.usage }),
        latencyMs: Math.max(0, performance.now() - started),
        repaired: attempt > 0,
      });
      try {
        return { output: validate(response.text), calls };
      } catch (error) {
        if (!(error instanceof StructuredOutputError || error instanceof SyntaxError)) throw error;
        repairReason = error.message;
        if (attempt + 1 >= attempts) {
          throw new TaskAgentExecutionError(
            `${role} returned invalid structured output after ${String(attempts)} attempts: ${error.message}`,
            role,
            calls,
          );
        }
      }
    }
    throw new TaskAgentExecutionError(`${role} did not produce output`, role, calls);
  }
}
