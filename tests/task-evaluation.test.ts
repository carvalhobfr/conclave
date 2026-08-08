import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TaskExecutionResult } from "../src/domain/task-execution.js";
import {
  loadTaskEvaluationCases,
  runTaskEvaluation,
} from "../src/evaluation/task-evaluation.js";
import {
  createTaskFixtureEngine,
  taskFixturePath,
} from "./helpers/task-fixture.js";

const temporaryPaths: string[] = [];

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "conclave-task-eval-"));
  temporaryPaths.push(path);
  await cp(taskFixturePath, path, { recursive: true });
  return path;
}

function trustImplementer(result: TaskExecutionResult): TaskExecutionResult {
  return {
    ...result,
    verdict: {
      ...result.verdict,
      status: "completed",
      summary: "Baseline trusts the Implementer completion report without adversarial gates",
    },
  };
}

afterEach(async () => {
  for (const path of temporaryPaths.splice(0)) await rm(path, { recursive: true, force: true });
});

describe("task evaluation", () => {
  it("measures false success and revision recovery against fixed baselines", async () => {
    const cases = await loadTaskEvaluationCases(
      resolve("tests/fixtures/task-auth/task-eval-cases.json"),
    );
    const report = await runTaskEvaluation(cases, {
      "single-implementer": async (evaluationCase) =>
        trustImplementer(
          await (
            await createTaskFixtureEngine("false-success", 1)
          ).execute({
            intent: "task",
            repositoryRoot: await root(),
            objective: evaluationCase.objective,
          }),
        ),
      "plan-implementer": async (evaluationCase) =>
        trustImplementer(
          await (
            await createTaskFixtureEngine("unrelated-then-correct", 1)
          ).execute({
            intent: "task",
            repositoryRoot: await root(),
            objective: evaluationCase.objective,
          }),
        ),
      "conclave-task": async (evaluationCase) =>
        (await createTaskFixtureEngine("unrelated-then-correct", 2)).execute({
          intent: "task",
          repositoryRoot: await root(),
          objective: evaluationCase.objective,
        }),
    });
    const single = report.strategies.find((strategy) => strategy.strategy === "single-implementer");
    const planned = report.strategies.find((strategy) => strategy.strategy === "plan-implementer");
    const conclave = report.strategies.find((strategy) => strategy.strategy === "conclave-task");

    expect(single?.metrics.falseSuccessRate).toBe(1);
    expect(single?.metrics.taskSuccessRate).toBe(0);
    expect(planned?.metrics.falseSuccessRate).toBe(1);
    expect(planned?.metrics.unrelatedEditRate).toBe(1);
    expect(conclave?.metrics.taskSuccessRate).toBe(1);
    expect(conclave?.metrics.falseSuccessRate).toBe(0);
    expect(conclave?.metrics.unrelatedEditRate).toBe(0);
    expect(conclave?.metrics.revisionSuccessRate).toBe(1);
  });
});
