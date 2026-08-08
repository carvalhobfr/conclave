import type { Evidence } from "../domain/evidence.js";
import type {
  ChangedFile,
  CheckResult,
  ImplementationClaim,
  RequirementVerification,
  TaskRequirement,
  TaskVerificationStrategy,
} from "../domain/task-execution.js";
import type { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";

export interface TaskVerificationExecution {
  readonly result: RequirementVerification;
  readonly evidence: readonly Evidence[];
}

function verification(
  id: string,
  strategy: TaskVerificationStrategy,
  outcome: RequirementVerification["outcome"],
  explanation: string,
  evidence: readonly Evidence[] = [],
  checkRequestIds: readonly string[] = [],
): TaskVerificationExecution {
  return {
    result: {
      requirementId: id,
      outcome,
      method: strategy.kind,
      explanation,
      evidenceIds: evidence.map((item) => item.id),
      checkRequestIds,
    },
    evidence,
  };
}

function expectedOutcome(found: boolean, expectation: "present" | "absent"): "supported" | "rejected" {
  return found === (expectation === "present") ? "supported" : "rejected";
}

export class TaskDeterministicVerifier {
  readonly #retrieval: CodeRetrievalService;
  readonly #changedFiles: readonly ChangedFile[];
  readonly #checks: readonly CheckResult[];

  public constructor(
    retrieval: CodeRetrievalService,
    changedFiles: readonly ChangedFile[],
    checks: readonly CheckResult[],
  ) {
    this.#retrieval = retrieval;
    this.#changedFiles = changedFiles;
    this.#checks = checks;
  }

  public verifyRequirement(requirement: TaskRequirement): TaskVerificationExecution {
    return this.#verify(requirement.id, requirement.verification);
  }

  public verifyClaim(claim: ImplementationClaim): TaskVerificationExecution {
    return this.#verify(claim.id, claim.verification);
  }

  #verify(id: string, strategy: TaskVerificationStrategy): TaskVerificationExecution {
    switch (strategy.kind) {
      case "source-contains": {
        const evidence = this.#retrieval
          .searchText(strategy.text, { limit: 30 })
          .filter((item) => item.path === strategy.path);
        const found = evidence.length > 0;
        return verification(
          id,
          strategy,
          expectedOutcome(found, strategy.expectation),
          `${strategy.path} ${found ? "contains" : "does not contain"} the required exact source text`,
          evidence,
        );
      }
      case "symbol-exists": {
        const evidence = this.#retrieval.findSymbol(strategy.symbol, strategy.path);
        const found = evidence.length > 0;
        return verification(
          id,
          strategy,
          expectedOutcome(found, strategy.expectation),
          `Symbol ${strategy.symbol} ${found ? "exists" : "was not found"}`,
          evidence,
        );
      }
      case "graph-path": {
        const path = this.#retrieval.graph.shortestPathBetweenSymbols(strategy.from, strategy.to, {
          maxDepth: strategy.maxDepth ?? 4,
          maxNodes: 80,
        });
        if (path.status === "ambiguous" || path.status === "not-found") {
          return verification(
            id,
            strategy,
            "uncertain",
            `Graph path endpoints could not be uniquely resolved: ${path.status}`,
          );
        }
        const found = path.status === "found";
        const evidence =
          path.status === "found"
            ? path.nodes.flatMap((node) =>
                node.reference.kind === "symbol"
                  ? (this.#retrieval.readUnit(node.reference.id) ?? [])
                  : [],
              )
            : [];
        return verification(
          id,
          strategy,
          expectedOutcome(found, strategy.expectation),
          `Graph path ${found ? "exists" : "does not exist"} from ${strategy.from} to ${strategy.to}`,
          evidence,
        );
      }
      case "callers": {
        const resolution = this.#retrieval.graph.getNodeBySymbol(strategy.symbol, undefined, 30);
        if (resolution.status !== "resolved") {
          return verification(
            id,
            strategy,
            "uncertain",
            `Caller target could not be uniquely resolved: ${resolution.status}`,
          );
        }
        const relations = this.#retrieval.graph.callers(resolution.node.reference, {
          maxDepth: 1,
          maxNodes: 100,
        });
        const evidence = relations.flatMap((relation) =>
          relation.node.reference.kind === "symbol"
            ? (this.#retrieval.readUnit(relation.node.reference.id) ?? [])
            : [],
        );
        return verification(
          id,
          strategy,
          relations.length >= strategy.minimum ? "supported" : "rejected",
          `${strategy.symbol} has ${String(relations.length)} deterministic callers; minimum is ${String(strategy.minimum)}`,
          evidence,
        );
      }
      case "changed-file": {
        const found = this.#changedFiles.some((file) => file.path === strategy.path);
        const expectedChanged = strategy.expectation === "changed";
        return verification(
          id,
          strategy,
          found === expectedChanged ? "supported" : "rejected",
          `${strategy.path} is ${found ? "changed" : "unchanged"}`,
        );
      }
      case "check-passed": {
        const checks = this.#checks.filter((check) => check.requestId === strategy.requestId);
        const check = checks.at(-1);
        if (check === undefined) {
          return verification(id, strategy, "rejected", `Required check ${strategy.requestId} was not executed`);
        }
        return verification(
          id,
          strategy,
          check.status === "passed" ? "supported" : "rejected",
          `Required check ${strategy.requestId} finished with ${check.status}`,
          [],
          [check.requestId],
        );
      }
    }
  }
}
