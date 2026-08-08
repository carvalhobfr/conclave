import { readFile } from "node:fs/promises";

import type { TaskExecutionResult } from "../domain/task-execution.js";

export interface TaskEvaluationCase {
  readonly id: string;
  readonly repositoryPath: string;
  readonly objective: string;
  readonly expectedChangedFiles: readonly string[];
}

export type TaskEvaluationStrategy =
  | "single-implementer"
  | "plan-implementer"
  | "conclave-task";

export type TaskEvaluationRunner = (
  evaluationCase: TaskEvaluationCase,
) => Promise<TaskExecutionResult>;

export interface TaskCaseEvaluation {
  readonly id: string;
  readonly reportedCompletion: boolean;
  readonly taskSuccess: boolean;
  readonly requirementSatisfaction: number;
  readonly falseSuccess: boolean;
  readonly unrelatedEdit: boolean;
  readonly revisionSuccess: boolean;
  readonly modelCalls: number;
  readonly contextTokens: number;
  readonly changedLines: number;
  readonly checks: number;
}

export interface TaskStrategyEvaluation {
  readonly strategy: TaskEvaluationStrategy;
  readonly metrics: {
    readonly reportedCompletionRate: number;
    readonly taskSuccessRate: number;
    readonly requirementSatisfaction: number;
    readonly falseSuccessRate: number;
    readonly unrelatedEditRate: number;
    readonly revisionSuccessRate: number;
    readonly meanModelCalls: number;
    readonly meanContextTokens: number;
    readonly meanChangedLines: number;
    readonly meanChecks: number;
  };
  readonly cases: readonly TaskCaseEvaluation[];
}

export interface TaskEvaluationReport {
  readonly caseCount: number;
  readonly strategies: readonly TaskStrategyEvaluation[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export async function loadTaskEvaluationCases(path: string): Promise<readonly TaskEvaluationCase[]> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("Task evaluation cases must be a JSON array");
  return parsed.map((item) => {
    if (
      !isRecord(item) ||
      typeof item["id"] !== "string" ||
      typeof item["repositoryPath"] !== "string" ||
      typeof item["objective"] !== "string" ||
      !strings(item["expectedChangedFiles"])
    ) {
      throw new Error("Task evaluation case is invalid");
    }
    return {
      id: item["id"],
      repositoryPath: item["repositoryPath"],
      objective: item["objective"],
      expectedChangedFiles: item["expectedChangedFiles"],
    };
  });
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function evaluateCase(
  evaluationCase: TaskEvaluationCase,
  result: TaskExecutionResult,
): TaskCaseEvaluation {
  const required = result.task.plan.requirements.filter((requirement) => requirement.required);
  const supported = required.filter(
    (requirement) =>
      result.verdict.requirements.find((verification) => verification.requirementId === requirement.id)
        ?.outcome === "supported",
  ).length;
  const requirementSatisfaction = required.length === 0 ? 1 : supported / required.length;
  const expected = new Set(evaluationCase.expectedChangedFiles);
  const actual = result.verdict.changedFiles.map((file) => file.path);
  const unrelatedEdit = actual.some((path) => !expected.has(path));
  const expectedChangesPresent = [...expected].every((path) => actual.includes(path));
  const reportedCompletion =
    result.verdict.status === "completed" || result.verdict.status === "completed-with-uncertainty";
  const taskSuccess =
    reportedCompletion && requirementSatisfaction === 1 && !unrelatedEdit && expectedChangesPresent;
  return {
    id: evaluationCase.id,
    reportedCompletion,
    taskSuccess,
    requirementSatisfaction: rounded(requirementSatisfaction),
    falseSuccess: reportedCompletion && !taskSuccess,
    unrelatedEdit,
    revisionSuccess: result.verdict.revisionRounds > 0 && taskSuccess,
    modelCalls: result.metrics.investigation.modelCalls + result.metrics.taskModelCalls,
    contextTokens:
      result.metrics.investigation.approximateInputTokens + result.metrics.approximateInputTokens,
    changedLines: result.metrics.changedLines,
    checks: result.metrics.commandCount,
  };
}

export async function runTaskEvaluation(
  cases: readonly TaskEvaluationCase[],
  runners: Readonly<Record<TaskEvaluationStrategy, TaskEvaluationRunner>>,
): Promise<TaskEvaluationReport> {
  const strategies: readonly TaskEvaluationStrategy[] = [
    "single-implementer",
    "plan-implementer",
    "conclave-task",
  ];
  const evaluations: TaskStrategyEvaluation[] = [];
  for (const strategy of strategies) {
    const results: TaskCaseEvaluation[] = [];
    for (const evaluationCase of cases) {
      results.push(evaluateCase(evaluationCase, await runners[strategy](evaluationCase)));
    }
    evaluations.push({
      strategy,
      metrics: {
        reportedCompletionRate: rounded(average(results.map((result) => (result.reportedCompletion ? 1 : 0)))),
        taskSuccessRate: rounded(average(results.map((result) => (result.taskSuccess ? 1 : 0)))),
        requirementSatisfaction: rounded(average(results.map((result) => result.requirementSatisfaction))),
        falseSuccessRate: rounded(average(results.map((result) => (result.falseSuccess ? 1 : 0)))),
        unrelatedEditRate: rounded(average(results.map((result) => (result.unrelatedEdit ? 1 : 0)))),
        revisionSuccessRate: rounded(average(results.map((result) => (result.revisionSuccess ? 1 : 0)))),
        meanModelCalls: rounded(average(results.map((result) => result.modelCalls))),
        meanContextTokens: rounded(average(results.map((result) => result.contextTokens))),
        meanChangedLines: rounded(average(results.map((result) => result.changedLines))),
        meanChecks: rounded(average(results.map((result) => result.checks))),
      },
      cases: results,
    });
  }
  return { caseCount: cases.length, strategies: evaluations };
}
